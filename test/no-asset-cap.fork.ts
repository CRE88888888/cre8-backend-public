/** #92 opt-in acceptance. Run with bun run test/no-asset-cap.fork.ts after the CLEAN
 * contracts 71870a7 deploy-97.sh fork on 8562, open-market clock, 30-minute
 * TWAP history, fresh PushFeedsTestnet + PokePoolsTestnet, and a freshly migrated
 * dedicated DB. No automatic bun-test discovery.
 * Env only: CHAIN_ID=97, RPC_URL=http://127.0.0.1:8562, PORT=3062, DATABASE_URL
 * (cre8_be92), MIGRATIONS_DIR, OPERATOR_PRIVATE_KEY, SESSION_KEY_MASTER_SEED,
 * PAYMASTER_SIGNER_PRIVATE_KEY, BUNDLER_EXECUTOR_PRIVATE_KEY, BUNDLER_UTILITY_PRIVATE_KEY,
 * ALTO_CLI_PATH (installed alto CLI), BUNDLER_URL=http://127.0.0.1:3162,
 * Sponsorship runs at an explicit local 1 gwei node gas price with default quotas.
 * Keys may be loaded into env by a local launcher; this file never reads key files.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { openSync, closeSync, mkdirSync } from 'node:fs';
import { setTimeout as pause } from 'node:timers/promises';
import { createPublicClient, createTestClient, encodeFunctionData, erc20Abi, getAddress, http, parseAbi } from 'viem';
import type { Address } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { bscTestnet } from 'viem/chains';
import { createSiweMessage } from 'viem/siwe';
import { createKernelAccount, createKernelAccountClient } from '@zerodev/sdk';
import { KERNEL_V3_3 } from '@zerodev/sdk/constants';
import { signerToEcdsaValidator } from '@zerodev/ecdsa-validator';
import { closePool, query } from '../src/db.js';
import { getConfig } from '../src/config.js';
import { TESTNET_97 as P } from '../src/testnet-profile.js';
import { assertUserOpCapacity } from '../src/execution-batch.js';
import { singlePortfolioClaim } from '../src/operator.js';
import { countSwapExecuted, runSchedulerOnce } from '../src/scheduler.js';
import { checkTestnetProfile } from '../src/testnet-preflight.js';
import { buildRedeemPlan } from '../src/operator.js';
import { EXECUTOR_ABI } from '../src/chain.js';
import { planPortfolio } from '../src/snapshot.js';
const RPC = 'http://127.0.0.1:8562';
const API = 'http://127.0.0.1:3062';
const BUNDLER = 'http://127.0.0.1:3162';
const client = createPublicClient({ chain: bscTestnet, transport: http(RPC, { timeout: 120000, retryCount: 0 }), cacheTime: 0 });
const local = createTestClient({ chain: bscTestnet, mode: 'anvil', transport: http(RPC) });
let passes = 0;
function check(value: unknown, label: string): asserts value { assert.ok(value, label); console.log('PASS ' + label); passes++; }
function obj(value: unknown): Record<string, unknown> { assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value)); return Object.fromEntries(Object.entries(value)); }
function str(value: unknown): string { assert.equal(typeof value, 'string'); return String(value); }
function addr(value: unknown): Address { return getAddress(str(value)); }
let token = '';
async function request(path: string, method = 'GET', body?: unknown, status = 200) {
  const response = await fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120000) });
  const result: unknown = await response.json();
  assert.equal(response.status, status, path + ' status; code=' + String(obj(result).code ?? 'none'));
  return obj(result);
}
async function ready(url: string, rpc: boolean) {
  for (let n = 0; n < 100; n++) {
    try {
      const response = await fetch(url, rpc ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_supportedEntryPoints', params: [] }), signal: AbortSignal.timeout(1000) } : { signal: AbortSignal.timeout(1000) });
      const body: unknown = await response.json();
      if (response.ok && (!rpc || Array.isArray(obj(body).result))) return;
    } catch { /* readiness only; never print URLs or upstream payloads */ }
    await pause(300);
  }
  throw new Error('local service readiness failed');
}
async function main() {
  const config = getConfig();
  check(config.chainId === 97 && config.rpcUrl === RPC && config.port === 3062 && new URL(config.databaseUrl).pathname === '/cre8_be92', 'dedicated chain/ports/DB guard');
  check(process.env.BUNDLER_URL === BUNDLER && process.env.ALTO_CLI_PATH && process.env.PAYMASTER_SIGNER_PRIVATE_KEY && process.env.BUNDLER_EXECUTOR_PRIVATE_KEY && process.env.BUNDLER_UTILITY_PRIVATE_KEY, 'required env only');
  // anvil_nodeInfo is intentionally unavailable on a public RPC.
  const info = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'anvil_nodeInfo', params: [] }) }).then((r) => r.json());
  check(obj(info).result && await client.getChainId() === 97, 'local anvil chain 97');
  // Explicit local 1 gwei scenario, including bundler simulation deployment.
  // The deployment script funds utility with 0.02 tBNB; an artificial 10 gwei
  // base fee would exhaust that setup balance before the acceptance can start.
  await local.setNextBlockBaseFeePerGas({ baseFeePerGas: 0n });
  await local.mine({ blocks: 1 });
  // A rerun gets a fresh public-test owner and Kernel; it cannot accidentally
  // reuse an enrollment left by an interrupted run after rebuilding the DB.
  const owner = mnemonicToAccount('test test test test test test test test test test test junk',
    { addressIndex: Number((await client.getBlockNumber()) % (1n << 31n)) });
  check((await checkTestnetProfile(client)).every((c) => c.level === 'ok'), '319 pinned runtime hashes and selectors');
  mkdirSync('.bun-cache', { recursive: true });
  const log = openSync('.bun-cache/no-asset-cap-services.log', 'a', 0o600);
  const alto = spawn('sh', ['alto/entrypoint.sh'], { stdio: ['ignore', log, log], env: { ...process.env, CHAIN_ID: '97', PORT: '3162', RPC_URL: RPC,
    EXECUTOR_PRIVATE_KEY: process.env.BUNDLER_EXECUTOR_PRIVATE_KEY, UTILITY_PRIVATE_KEY: process.env.BUNDLER_UTILITY_PRIVATE_KEY } });
  const backend = spawn(process.execPath, ['src/index.ts'], { stdio: ['ignore', log, log], env: process.env });
  let strategyId: number | undefined;
  try {
    await ready(BUNDLER, true); await ready(API + '/health', false);
    check((await request('/health')).chainId === 97, 'backend starts on 3062 with chain 97');
    const challenge = await request('/auth/nonce', 'POST');
    const message = createSiweMessage({ address: owner.address, chainId: 97, domain: str(challenge.domain), uri: str(challenge.uri), nonce: str(challenge.nonce), statement: str(challenge.statement), version: '1', issuedAt: new Date(str(challenge.issuedAt)) });
    token = str((await request('/auth/login', 'POST', { message, signature: await owner.signMessage({ message }) })).token);
    check(token.length > 0, 'real SIWE HTTP login');
    const strategy = await request('/strategies', 'POST', { name: '#92 all 93 assets', isPublic: false }, 201);
    assert.equal(typeof strategy.id, 'number'); strategyId = Number(strategy.id);

    const assets=Object.values(P.assets).map((a,i)=>({address:a.token,weightBps:i<64?109:108}));
    const version=await request(`/strategies/${strategyId}/versions`,'POST',{allocation:{assets},chainId:97,schedule:{kind:'funding'}},201);
    const publishedAssets=obj(version.allocation).assets;
    check(Array.isArray(publishedAssets)&&publishedAssets.length===93,'HTTP publishes 93-asset per_asset version to DB and chain');
    const portfolio=await request('/portfolios','POST',{strategyId},201);
    assert.ok(Array.isArray(portfolio.smartAccounts));
    const portfolioId=Number(portfolio.id),account=addr(obj(portfolio.smartAccounts[0]).address);
    const claimed=await request('/faucet/usdt','POST',{account});
    check(claimed.state==='confirmed','real faucet 1000-USDT receipt');
    await request(`/portfolios/${portfolioId}/funding-lots`,'POST',{source:{kind:'faucet_claim',claimId:claimed.claimId}});
    check((await query('select asset from strategy_lot_assets where lot_id in (select id from strategy_funding_lots where portfolio_id=$1)',[portfolioId])).rows.length===93,'93 asset budgets created by DB contract');
    // A donation is not principal. It supplies the existing 2% buy-cap safety margin.
    await local.impersonateAccount({address:P.roles.operator});
    const donation=await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_sendTransaction',params:[{from:P.roles.operator,to:P.contracts.usdt,gas:'0x30d40',data:encodeFunctionData({abi:parseAbi(['function mint(address,uint256)']),functionName:'mint',args:[account,100n*10n**18n]})}]})}).then(r=>r.json());
    check(typeof obj(donation).result==='string','local operator donation excluded from funding lots');
    const entryPoint={address:P.contracts.entryPoint,version:'0.7'} as const;
    const sudo=await signerToEcdsaValidator(client,{signer:owner,entryPoint,kernelVersion:KERNEL_V3_3,validatorAddress:P.contracts.ecdsaValidatorV31});
    const kernel=await createKernelAccount(client,{address:account,plugins:{sudo},entryPoint,kernelVersion:KERNEL_V3_3,factoryAddress:P.contracts.kernelFactoryV33,metaFactoryAddress:P.contracts.kernelMetaFactory,accountImplementationAddress:P.contracts.kernelImplV33});
    const ownerClient=createKernelAccountClient({account:kernel,chain:bscTestnet,client,bundlerTransport:http(BUNDLER,{timeout:120000}),userOperation:{estimateFeesPerGas:async()=>{const price=await client.getGasPrice();return {maxFeePerGas:price,maxPriorityFeePerGas:price};}}});
    const send=async(calls:{to:Address;data:`0x${string}`}[])=>{
      const estimate=await ownerClient.estimateUserOperationGas({calls});
      const callGasLimit=estimate.callGasLimit*3n/2n;
      assertUserOpCapacity(calls.length,callGasLimit+estimate.verificationGasLimit+estimate.preVerificationGas);
      const hash=await ownerClient.sendUserOperation({calls,callGasLimit,verificationGasLimit:estimate.verificationGasLimit,preVerificationGas:estimate.preVerificationGas});
      const receipt=await ownerClient.waitForUserOperationReceipt({hash,timeout:120000});assert.ok(receipt.success);return receipt;
    };
    await local.setBalance({address:account,value:10n**18n});
    const approve=(token:Address)=>({to:token,data:encodeFunctionData({abi:erc20Abi,functionName:'approve',args:[P.contracts.executor,(1n<<256n)-1n]})});
    await send([approve(P.contracts.usdt)]);
    await local.setBalance({address:account,value:0n});
    await local.setNextBlockBaseFeePerGas({baseFeePerGas:0n});await local.mine({blocks:1});
      check(await client.getGasPrice()===1_000_000_000n,'default sponsorship quotas tested at 1 gwei');
    const originalNow=Date.now;
    const block=await client.getBlock();const offset=Number(block.timestamp)*1000-originalNow();Date.now=()=>originalNow()+offset;
    let buyBatches=0,buySwaps=0,buyGas=0n,sellBatches=0,sellSwaps=0,sellGas=0n;
    try{
      for(let n=0;n<60;n++){
        // Production waits for a new block after a confirmed pool trade. Anvil
        // automines transactions only, so explicitly advance that same gate.
        await local.mine({blocks:1});
        await query('update portfolios set next_run_at=null where id=$1',[portfolioId]);
        const now=new Date(Date.now());
        const round=await runSchedulerOnce({dryRun:false,now,skipAlerts:true},{withTransaction:singlePortfolioClaim(portfolioId),clock:()=>new Date(Date.now())});
        const result=round.results.find(r=>r.portfolioId===portfolioId);assert.ok(result);
        if(result.outcome==='noop')break;
        assert.equal(result.outcome,'executed',result.reason?.split('\n')[0]);assert.ok(result.execution?.txHash&&result.plan);
        const receipt=await client.getTransactionReceipt({hash:result.execution.txHash});
        const swaps=countSwapExecuted(receipt.logs,P.contracts.executor);assert.equal(swaps,result.plan.steps.length);assert.ok(swaps<=16);
        buyBatches++;buySwaps+=swaps;buyGas+=BigInt(result.execution.gasUsed??'0');
        const rows=await query<{state:string}>('select state from strategy_jobs where portfolio_id=$1',[portfolioId]);
        if(rows.rows.length===1&&rows.rows[0]?.state==='completed')break;
      }
      check(buySwaps===92&&buyBatches>1,'production scheduler buys all 92 assets in bounded UserOps');
      const ledger=await query<{gas:string;max:string}>("select coalesce(sum(gas_limit),0)::text as gas,coalesce(max(gas_limit),0)::text as max from gas_budget_reservations where chain_id=97 and account=$1 and purpose='ordinary'",[account.toLowerCase()]);
      check(BigInt(ledger.rows[0]?.gas??'0')<=100_000_000n,'all buy reservations fit the 100M daily budget');
      check(BigInt(ledger.rows[0]?.max??'0')<=14_000_000n,'every prepared buy UserOp fits 14M');
      console.log('buy reserved gas='+ledger.rows[0]?.gas+'; maximum UserOp gas='+ledger.rows[0]?.max);
      for(const asset of assets)assert.ok(await client.readContract({address:asset.address,abi:erc20Abi,functionName:'balanceOf',args:[account]})>0n);
      await local.setBalance({address:account,value:10n**18n});
      for(let i=0;i<assets.length;i+=16)await send(assets.slice(i,i+16).map(a=>approve(a.address)));
      for(let n=0;n<60;n++){
        const plan=await planPortfolio(portfolioId);
        const redeem=await buildRedeemPlan({portfolioId,plan,account},{close:true},{publicClient:client,executor:P.contracts.executor,query});
        if(redeem.plan.kind==='noop')break;
        assert.equal(redeem.plan.kind,'ready',redeem.plan.kind==='blocked'?redeem.plan.reason:'missing plan');
        const receipt=await send([{to:P.contracts.executor,data:encodeFunctionData({abi:EXECUTOR_ABI,functionName:'executeRebalance',args:[account,redeem.plan.steps,redeem.plan.deadline]})}]);
        const swaps=countSwapExecuted(receipt.receipt.logs,P.contracts.executor);assert.equal(swaps,redeem.plan.steps.length);assert.ok(swaps<=16);
        sellSwaps+=swaps;sellBatches++;sellGas+=receipt.actualGasUsed;
      }
      check(sellSwaps===92&&sellBatches>1,'redeem planner sells all 92 assets in bounded UserOps');
      for(const asset of assets)assert.equal(await client.readContract({address:asset.address,abi:erc20Abi,functionName:'balanceOf',args:[account]}),0n);
      const cash=await client.readContract({address:P.contracts.usdt,abi:erc20Abi,functionName:'balanceOf',args:[account]});
      const before=await client.readContract({address:P.contracts.usdt,abi:erc20Abi,functionName:'balanceOf',args:[owner.address]});
      await send([{to:P.contracts.usdt,data:encodeFunctionData({abi:erc20Abi,functionName:'transfer',args:[owner.address,cash]})}]);
      check(await client.readContract({address:P.contracts.usdt,abi:erc20Abi,functionName:'balanceOf',args:[owner.address]})===before+cash,'owner receives exact final USDT');
      console.log(`NO_ASSET_CAP_ACCEPTANCE: ${passes} pass / 0 skip / 0 fail; assets=93; buy batches=${buyBatches}; swaps=${buySwaps}; actual gas=${buyGas}; sell batches=${sellBatches}; swaps=${sellSwaps}; actual gas=${sellGas}`);
    }finally{Date.now=originalNow;}
  }finally{token='';backend.kill('SIGTERM');alto.kill('SIGTERM');closeSync(log);await closePool();}
}
main().catch((error:unknown)=>{console.error('NO_ASSET_CAP_ACCEPTANCE failed: '+(error instanceof Error?error.message.split('\n')[0]:'unknown'));process.exitCode=1;});
