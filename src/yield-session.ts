import { concatHex, isAddressEqual, pad, parseAbi, toFunctionSelector, zeroAddress } from 'viem';
import type { Address, PublicClient } from 'viem';
import { yieldAuthorization } from './permissions.js';
import { fresh, object, unavailable } from './yield-domain.js';

const GAS = parseAbi(['function gasPolicyConfig(bytes32,address) view returns(uint128 allowed,bool enforcePaymaster,address allowedPaymaster)']);
const PERMISSION = parseAbi([
  'function permissionConfig(bytes4) view returns ((bytes2 permissionFlag,address signer,bytes22[] policyData))',
  'function validationConfig(bytes21) view returns ((uint32 nonce,address hook))',
  'function validNonceFrom() view returns(uint32)',
  'function isAllowedSelector(bytes21,bytes4) view returns(bool)',
]);

/** API selection and the final pre-reservation check share time/installation evidence.
 * A dependency failure is unknown, never proof that it is safe to try a different key.
 */
export async function yieldSessionAvailable(client: PublicClient, policies: unknown, account: Address, executor: Address, now: Date): Promise<boolean> {
  if (yieldAuthorization(policies, account, executor).status !== 'ready') return false;
  const p = object(policies), timestamp = object(p.timestamp);
  const until = timestamp.validUntil, after = timestamp.validAfter;
  const wall = Math.floor(now.getTime() / 1000);
  if (typeof until !== 'number' || !Number.isSafeInteger(until) || until <= wall ||
      typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0 || after > wall ||
      typeof p.permissionId !== 'string' || !/^0x[0-9a-fA-F]{8}$/.test(p.permissionId)) return false;
  const block = await client.getBlock({ blockTag: 'latest' });
  if (block.number===null||block.hash===null||await client.getChainId() !== 97 || !fresh(new Date(Number(block.timestamp) * 1000), now)) throw unavailable();
  if (block.timestamp >= BigInt(until) || block.timestamp < BigInt(after)) return false;
  const id=pad(concatHex(['0x02',`0x${p.permissionId.slice(2)}`]),{size:21,dir:'right'});
  const [installed,validation,minimumNonce,allowed]=await Promise.all([
    client.readContract({address:account,abi:PERMISSION,functionName:'permissionConfig',args:[`0x${p.permissionId.slice(2)}`],blockNumber:block.number}),
    client.readContract({address:account,abi:PERMISSION,functionName:'validationConfig',args:[id],blockNumber:block.number}),
    client.readContract({address:account,abi:PERMISSION,functionName:'validNonceFrom',blockNumber:block.number}),
    client.readContract({address:account,abi:PERMISSION,functionName:'isAllowedSelector',args:[id,toFunctionSelector('execute(bytes32,bytes)')],blockNumber:block.number}),
  ]);
  const gas=object(p.gas);
  if(typeof gas.policyAddress!=='string'||!/^0x[0-9a-fA-F]{40}$/.test(gas.policyAddress))throw unavailable();
  const [remaining]=await client.readContract({address:gas.policyAddress as Address,abi:GAS,functionName:'gasPolicyConfig',args:[pad(`0x${p.permissionId.slice(2)}`,{dir:'right'}),account],blockNumber:block.number});
  if((await client.getBlock({blockNumber:block.number})).hash!==block.hash)throw unavailable();
  return remaining>0n && !isAddressEqual(installed.signer, zeroAddress) && installed.policyData.length === 3 &&
    !isAddressEqual(validation.hook,zeroAddress) && validation.nonce>=minimumNonce && allowed;
}
