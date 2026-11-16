import { decodeFunctionData, encodeFunctionData, isAddressEqual, parseAbi } from 'viem';
import type { PaymasterConfig } from './config.js';
import type { PackedSponsorOperation } from './paymaster.js';
import { canonicalKernelCalls } from './paymaster.js';
import { REGISTRY_ABI } from './registry-abi.js';
import { query } from './db.js';
import { AppError } from './errors.js';
import { preparePortfolioEnrollment } from './portfolios.js';
import { TESTNET_97 } from './testnet-profile.js';
const approveAbi = parseAbi(['function approve(address,uint256) returns(bool)']);
const denied = () => new AppError(403, 'PAYMASTER_SENDER_FORBIDDEN', 'enrollment setup does not match the owner intent');

/** Before a portfolio exists, only its persisted owner intent and exact rederived setup may be sponsored. */
export async function verifyEnrollmentSponsorship(op: PackedSponsorOperation, c: PaymasterConfig, wallet: string,
  deps: { query?: (sql: string, params?: readonly unknown[]) => Promise<{ rows: { strategy_id: string }[] }>; prepare?: typeof preparePortfolioEnrollment } = {}): Promise<void> {
  if (op.initCode !== '0x' || c.chainId !== 97 || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) throw denied();
  const calls = canonicalKernelCalls(op.callData);
  if (calls.length < 1 || calls.length > 2) throw denied();
  const enrollments = calls.filter(call => isAddressEqual(call.target, c.registry));
  if (enrollments.length !== 1) throw denied();
  const enrollment = enrollments[0];
  if (!enrollment || enrollment.value !== 0n || !isAddressEqual(enrollment.target, c.registry)) throw denied();
  const decoded = decodeFunctionData({ abi: REGISTRY_ABI, data: enrollment.callData });
  if (decoded.functionName !== 'enroll' || !isAddressEqual(decoded.args[0], op.sender) || decoded.args[1] === 0n || decoded.args[2] === 0 ||
      encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'enroll', args: decoded.args }).toLowerCase() !== enrollment.callData.toLowerCase()) throw denied();
  const approval = calls.find(call => call !== enrollment);
  if (approval) {
    if (approval.value !== 0n || !isAddressEqual(approval.target, TESTNET_97.contracts.usdt)) throw denied();
    const data = decodeFunctionData({ abi: approveAbi, data: approval.callData });
    if (!isAddressEqual(data.args[0], c.executor) || encodeFunctionData({ abi: approveAbi, functionName: 'approve', args: data.args }).toLowerCase() !== approval.callData.toLowerCase()) throw denied();
  }
  const rows = await (deps.query ?? query)(`select i.strategy_id from enrollment_intents i join strategies s on s.id=i.strategy_id
    where i.user_id=$1 and i.chain_id=97 and s.onchain_id=$2`, [wallet.toLowerCase(), decoded.args[1].toString()]);
  const id = Number(rows.rows[0]?.strategy_id);
  if (rows.rows.length !== 1 || !Number.isSafeInteger(id) || id < 1) throw denied();
  const prepared = await (deps.prepare ?? ((sid, owner) => preparePortfolioEnrollment(sid, owner, { verifyAccountDeployment: true })))(id, wallet);
  if (prepared.accountDeployed !== true || prepared.signingMode !== 'sudo' || !isAddressEqual(prepared.account, op.sender) || prepared.expectedVersion !== decoded.args[2] ||
      !isAddressEqual(prepared.call.to, c.registry) || prepared.call.value !== '0' || prepared.call.data.toLowerCase() !== enrollment.callData.toLowerCase()) throw denied();
}
