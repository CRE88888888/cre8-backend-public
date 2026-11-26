/** Read-only chain reconciliation; SQL unlock requires finalized expiry + original unused nonce.
 * bun --no-env-file scripts/reconcile-yield-exit.ts --evidence /private/path/evidence.json
 */
import { readFile } from 'node:fs/promises';
import { isAddress } from 'viem';
import { bindExitAuthorizationEvidence, reconcileExpiredExitAuthorizations } from '../src/paymaster.js';
import { closePool } from '../src/db.js';
import { AppError } from '../src/errors.js';

try{
  const args=process.argv.slice(2),file=args[1];
  if(args.length!==2||args[0]!=='--evidence'||!file||process.env.CHAIN_ID!=='97'||!process.env.RPC_URL)throw new Error('invalid input');
  const text=await readFile(file,'utf8');if(text.length>2_000_000)throw new Error('evidence too large');
  const value:unknown=JSON.parse(text);if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('invalid evidence');
  const v=value as Record<string,unknown>;
  if(Object.keys(v).some(k=>!['account','operator','reference','userOperations'].includes(k))||typeof v.account!=='string'||!isAddress(v.account)||v.account!==v.account.toLowerCase()||
    typeof v.operator!=='string'||!/^[a-zA-Z0-9_.:#/-]{1,128}$/.test(v.operator)||typeof v.reference!=='string'||!/^[a-zA-Z0-9_.:#/-]{1,256}$/.test(v.reference)||
    !Array.isArray(v.userOperations)||v.userOperations.length>1000)throw new Error('invalid evidence');
  for(const op of v.userOperations){
    if(!op||typeof op!=='object'||Array.isArray(op))throw new Error('account mismatch');
    const entry=op as Record<string,unknown>;
    if(typeof entry.sender!=='string'||entry.sender.toLowerCase()!==v.account)throw new Error('account mismatch');
    await bindExitAuthorizationEvidence(op);
  }
  const released=await reconcileExpiredExitAuthorizations({chainId:97,rpcUrl:process.env.RPC_URL,timeoutMs:10_000},v.account,{operator:v.operator,reference:v.reference});
  console.log(JSON.stringify({released}));
}catch(error){
  console.error(JSON.stringify({code:error instanceof AppError?error.code:'EXIT_RECONCILIATION_REJECTED'}));process.exitCode=1;
}finally{await closePool();}
