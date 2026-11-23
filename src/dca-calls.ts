import { decodeFunctionData, encodeFunctionData, isAddressEqual, parseAbi } from 'viem';
import type { Address, Hex } from 'viem';
import { APPROVE_GAS, VAULT_CALL_GAS, cashVaults } from './cash-earn.js';
import type { Call, CashVault } from './cash-earn.js';
import { yieldProfile } from './yield-domain.js';

/**
 * DCA (定投) vault calls, shared by the API (calldata the owner signs) and the paymaster (what it sponsors).
 * Kept free of DB/scheduler imports so the paymaster can depend on it.
 *
 * All three Cash Earn USDT vaults are used. Lista (ERC4626 `redeem(shares, receiver, owner)`) and Aave
 * (`withdraw(asset, max, to)`) pay the remainder straight to the owner wallet. The Venus mock only redeems to
 * the caller, so its return is `redeem(shares)` to the account plus a USDT transfer of the value read at quote
 * time; the interest accrued until inclusion (dust) is classified as the portfolio's allocated cash on confirm.
 */
export type DcaVault = CashVault & { marketId: Hex };
export const DCA_VAULT_ABI = parseAbi([
  'function approve(address,uint256) returns (bool)',
  'function transfer(address,uint256) returns (bool)',
  'function mint(uint256) returns (uint256)',
  'function redeem(uint256) returns (uint256)',
  'function deposit(uint256,address) returns (uint256)',
  'function redeem(uint256,address,address) returns (uint256)',
  'function supply(address,uint256,address,uint16)',
  'function withdraw(address,uint256,address) returns (uint256)',
  'function previewWithdraw(uint256) view returns (uint256)',
]);
const UINT256_MAX = (1n << 256n) - 1n;

export function dcaVaults(profile = yieldProfile()): DcaVault[] {
  if (!profile) return [];
  return cashVaults(profile).flatMap(v => {
    const market = profile.markets.find(m => m.id === v.id);
    return market ? [{ ...v, marketId: market.marketId }] : [];
  });
}

/** Account-side deposit: approve only when needed, then put `amountRaw` into the vault for the account itself. */
export function dcaDepositCalls(vault: DcaVault, account: Address, amountRaw: bigint, allowance: bigint): Call[] {
  const calls: Call[] = [];
  if (allowance < amountRaw) calls.push({ to: vault.asset, value: '0', gas: APPROVE_GAS,
    data: encodeFunctionData({ abi: DCA_VAULT_ABI, functionName: 'approve', args: [vault.spender, amountRaw] }) });
  calls.push({ to: vault.spender, value: '0', gas: VAULT_CALL_GAS, data: vault.protocol === 'lista'
    ? encodeFunctionData({ abi: DCA_VAULT_ABI, functionName: 'deposit', args: [amountRaw, account] })
    : vault.protocol === 'venus' ? encodeFunctionData({ abi: DCA_VAULT_ABI, functionName: 'mint', args: [amountRaw] })
      : encodeFunctionData({ abi: DCA_VAULT_ABI, functionName: 'supply', args: [vault.asset, amountRaw, account, 0] }) });
  return calls;
}
/** Lets the scheduler's session key redeem tranches through AtpExecutor.executeWithdraw (it pulls the receipt). */
export function dcaReceiptApproval(vault: DcaVault, executor: Address): Call {
  return { to: vault.receipt, value: '0', gas: APPROVE_GAS, data: encodeFunctionData({ abi: DCA_VAULT_ABI, functionName: 'approve', args: [executor, UINT256_MAX] }) };
}
/** Everything left to the owner wallet, from the account's position. Venus: redeem to the account, then send
 * `valueRaw` (the position value at quote time, never more than the redeem pays) on to the owner. */
export function dcaReturnCalls(vault: DcaVault, account: Address, owner: Address, shares: bigint, valueRaw: bigint): Call[] {
  if (vault.protocol === 'venus') return [
    { to: vault.spender, value: '0', gas: VAULT_CALL_GAS, data: encodeFunctionData({ abi: DCA_VAULT_ABI, functionName: 'redeem', args: [shares] }) },
    { to: vault.asset, value: '0', gas: APPROVE_GAS, data: encodeFunctionData({ abi: DCA_VAULT_ABI, functionName: 'transfer', args: [owner, valueRaw] }) },
  ];
  return [{ to: vault.spender, value: '0', gas: VAULT_CALL_GAS, data: vault.protocol === 'lista'
    ? encodeFunctionData({ abi: DCA_VAULT_ABI, functionName: 'redeem', args: [shares, owner, account] })
    : encodeFunctionData({ abi: DCA_VAULT_ABI, functionName: 'withdraw', args: [vault.asset, UINT256_MAX, owner] }) }];
}

/** Paymaster: USDT may be approved to a DCA vault's spender (the account deposits its own money). */
export function isDcaSpender(token: Address, spender: Address, vaults = dcaVaults()): boolean {
  return vaults.some(v => isAddressEqual(v.asset, token) && isAddressEqual(v.spender, spender));
}
/**
 * Paymaster: `true` = a DCA deposit for the sender itself, or a return of the sender's position to its owner.
 * `false` = not a DCA deposit/return call (other rules decide, e.g. Lista share approvals to the executor).
 * Throws on a DCA function with any other recipient, asset or a non-canonical encoding.
 */
export function dcaVaultCall(call: { target: Address; callData: Hex }, sender: Address, owner: Address | undefined, vaults = dcaVaults()): boolean {
  const vault = vaults.find(v => isAddressEqual(v.spender, call.target));
  if (!vault) return false;
  let inner;
  try { inner = decodeFunctionData({ abi: DCA_VAULT_ABI, data: call.callData }); } catch { return false; }
  const canonical = () => encodeFunctionData({ abi: DCA_VAULT_ABI, functionName: inner.functionName, args: inner.args } as never).toLowerCase() === call.callData.toLowerCase();
  // Venus mints to and redeems for the caller only: the account itself.
  if (vault.protocol === 'venus' && (inner.functionName === 'mint' || inner.functionName === 'redeem') && inner.args.length === 1) {
    if (inner.args[0] === 0n || !canonical()) throw new Error('invalid dca venus call');
    return true;
  }
  if (vault.protocol === 'lista' && inner.functionName === 'deposit') {
    if (inner.args[0] === 0n || !isAddressEqual(inner.args[1], sender) || !canonical()) throw new Error('invalid dca deposit');
    return true;
  }
  if (vault.protocol === 'lista' && inner.functionName === 'redeem') {
    const [shares, receiver, from] = inner.args as readonly [bigint, Address | undefined, Address | undefined];
    if (inner.args.length !== 3 || shares === 0n || owner === undefined || receiver === undefined || from === undefined ||
      !isAddressEqual(receiver, owner) || !isAddressEqual(from, sender) || !canonical()) throw new Error('invalid dca return');
    return true;
  }
  if (vault.protocol === 'aave_v3' && inner.functionName === 'supply') {
    if (!isAddressEqual(inner.args[0], vault.asset) || inner.args[1] === 0n || !isAddressEqual(inner.args[2], sender) || inner.args[3] !== 0 || !canonical()) throw new Error('invalid dca deposit');
    return true;
  }
  if (vault.protocol === 'aave_v3' && inner.functionName === 'withdraw') {
    if (!isAddressEqual(inner.args[0], vault.asset) || inner.args[1] === 0n || owner === undefined || !isAddressEqual(inner.args[2], owner) || !canonical()) throw new Error('invalid dca return');
    return true;
  }
  return false;
}
