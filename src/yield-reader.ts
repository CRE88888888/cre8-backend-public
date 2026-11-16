import { decodeFunctionResult, encodeFunctionData, keccak256, parseAbi } from 'viem';
import type { Address, Hex, PublicClient } from 'viem';
import { MULTICALL3_ADDRESS } from './positions.js';
import { fresh, object, raw, hash, address, RAY, UINT256_MAX, WAD, unavailable } from './yield-domain.js';
import type { Observation, YieldMarket, YieldPosition, YieldProfile, YieldRead, YieldRisk } from './yield-domain.js';

// Read-only subset; execution/owner/session ABI remains owned by BE-4.
const READ = parseAbi([
  'function getCash() view returns(uint256)', 'function totalReserves() view returns(uint256)', 'function actionPaused(address,uint8) view returns(bool)',
  'function getVirtualUnderlyingBalance(address) view returns(uint256)', 'function paused() view returns(bool)',
  'function marketCount() view returns(uint256)', 'function marketIds(uint256) view returns(bytes32)',
  'function registry() view returns(address)', 'function yieldRegistry() view returns(address)',
  'function enrollments(address) view returns(uint256 strategyId,uint16 version,bool paused)',
  'function historicalAssets(uint256) view returns(address[])',
  'function version(uint256,uint16) view returns((address[] assets,uint16[] weightsBps,bytes32 scheduleHash,uint64 activeAt,bytes32 settingsHash,uint16 performanceFeeBps,bytes32 configHash))',
  'function oracle() view returns(address)', 'function numeraire() view returns(address)', 'function previewSwap(address,address,uint256) view returns(uint256,uint256)',
  'function market(bytes32) view returns ((uint256 chainId,uint8 kind,address asset,address receipt,address target,address riskSource,bytes32 configuration,uint256 minRate,uint256 maxRate,bool supplyEnabled,bool retired))',
  'function refreshHealth(bytes32) returns ((uint256 supply,uint256 liquidity,uint256 utilizationBps,bytes32 configuration))',
  'function health(bytes32) view returns ((uint256 supply,uint256 liquidity,uint256 utilizationBps,bytes32 configuration))',
  'function rateCheckpoint(bytes32) view returns(uint256 rate,uint256 observedAt)',
  'function quoteWithdraw(bytes32,uint256) returns(uint256)',
  'function receiptAssets(bytes32,address) view returns(uint256)',
  'function accountUnits(address,bytes32) view returns(uint256)',
  'function totalUnits(bytes32) view returns(uint256)',
  'function exiting(address,bytes32) view returns(bool)', 'function supplyPaused() view returns(bool)',
  'function balanceOf(address) view returns(uint256)', 'function decimals() view returns(uint8)',
  'function scaledBalanceOf(address) view returns(uint256)', 'function exchangeRateStored() view returns(uint256)',
  'function convertToAssets(uint256) view returns(uint256)', 'function previewRedeem(uint256) view returns(uint256)',
  'function totalAssets() view returns(uint256)', 'function totalSupply() view returns(uint256)',
  'function maxWithdraw(address) view returns(uint256)', 'function maxRedeem(address) view returns(uint256)',
  'function maxDeposit(address) view returns(uint256)', 'function getReserveNormalizedIncome(address) view returns(uint256)',
  'function getReserveData(address) view returns(uint256 configuration)', 'function supplyCaps(address) view returns(uint256)',
  'function aprBps() view returns(uint256)', 'function previewAccountValue(address) returns(uint256)',
  'function supplyQueueLength() view returns(uint256)', 'function withdrawQueueLength() view returns(uint256)',
  'function supplyQueue(uint256) view returns(bytes32)', 'function withdrawQueue(uint256) view returns(bytes32)',
]);
// Aave getReserveData is an entirely static tuple: this read projects its first uint256 configuration word.
const MULTICALL = parseAbi(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns((bool success,bytes returnData)[])']);
type ReadName = typeof READ[number]['name'];
type ReadCall = { target: Address; name: ReadName; args?: readonly [] | readonly [Hex] | readonly [bigint] | readonly [Hex, Hex] | readonly [Hex, bigint] | readonly [Hex, Hex, bigint] | readonly [bigint, number] | readonly [Hex, number] };
export async function yieldBatch(client: PublicClient, block: bigint, calls: readonly ReadCall[]): Promise<unknown[]> {
  const result = await client.simulateContract({ address: MULTICALL3_ADDRESS, abi: MULTICALL, functionName: 'aggregate3',
    args: [calls.map(c => ({ target: c.target, allowFailure: true,
      callData: encodeFunctionData({ abi: READ, functionName: c.name, args: c.args }) }))], blockNumber: block });
  if (result.result.length !== calls.length) throw unavailable();
  return result.result.map((r, index) => {
    const call = calls[index];
    if (!call || !r.success || r.returnData === '0x') return null;
    try { return decodeFunctionResult({ abi: READ, functionName: call.name, data: r.returnData }); } catch { return null; }
  });
}
const num = (v: unknown) => {const n=typeof v==='number'?v:Number(raw(v));if(!Number.isSafeInteger(n)||n<0)throw unavailable();return n;};
const integer = (v: unknown) => raw(v);
const ceil = (a: bigint, b: bigint) => (a + b - 1n) / b;
const min = (...ns: bigint[]) => ns.reduce((a, b) => a < b ? a : b);
/** Reviewed chain 97 registry has no on-chain reservations; capacity reserves live only in DB. */
export type MarketIdentity = { market: YieldMarket; riskSource: Address; configuration: Hex; totalUnits: bigint;
  minRate: bigint; maxRate: bigint; retired: boolean; supplyOpen: boolean; underlyingDecimals: number; receiptDecimals: number; queues: Hex[] };
export type YieldReaderDeps = { now: () => Date; timeoutMs: number; batch: typeof yieldBatch };
async function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(unavailable()), timeoutMs); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
/** One eth_call per shared group: sync/rate checks precede balances, claims, S/L/U and cap reads.
 * Independent eth_calls at one block DO NOT share Venus/Lista accrual state.
 */
export async function readYieldAccount(client: PublicClient, profile: YieldProfile, account: Address,
  options: Partial<YieldReaderDeps> & { block?: bigint } = {}): Promise<YieldRead> {
  const deps: YieldReaderDeps = { now: () => new Date(), timeoutMs: 15000, batch: yieldBatch, ...options };
  try {return await bounded(read(), deps.timeoutMs);} catch {throw unavailable();}
  async function read(): Promise<YieldRead> {
    if (await client.getChainId() !== profile.chainId) throw unavailable();
    const block = await client.getBlock(options.block === undefined ? { blockTag: 'latest' } : { blockNumber: options.block });
    if (block.number === null || block.hash === null) throw unavailable();
    if(profile.registryCodeHash!==undefined){
      const code=await client.getCode({address:profile.registry,blockNumber:block.number});
      if(!code||code==='0x'||keccak256(code)!==profile.registryCodeHash)throw unavailable();
    }
    const base = await deps.batch(client, block.number, [{target: profile.executor, name: 'oracle'}, {target: profile.executor, name: 'numeraire'}, {target:profile.registry,name:'supplyPaused'}, {target:profile.executor,name:'registry'}, {target:profile.registry,name:'marketCount'}, {target:profile.executor,name:'yieldRegistry'}]);
    const oracle = address(base[0]), numeraire = address(base[1]), strategyRegistry=address(base[3]);
    if(address(base[5])!==profile.registry||integer(base[4])!==BigInt(profile.markets.length))throw unavailable();
    const marketIds=await deps.batch(client,block.number,profile.markets.map((_m,index):ReadCall=>({target:profile.registry,name:'marketIds',args:[BigInt(index)]})));
    if(new Set(marketIds.map(hash)).size!==profile.markets.length||marketIds.some(id=>!profile.markets.some(m=>m.marketId===id)))throw unavailable();
    const observation: Observation = { block: block.number, blockHash: block.hash, at: new Date(Number(block.timestamp) * 1000), source: 'canonical-yield-registry' };
    if (!fresh(observation.at, deps.now())) throw unavailable();
    const identities = await Promise.all(profile.markets.map(m => identity(m)));
    const groups = new Map<string, MarketIdentity[]>();
    const positions: YieldPosition[] = [], risks: YieldRisk[] = [];
    for (const i of identities) {
      if (i === null) continue;
      const key = `${i.market.protocol}:${i.riskSource}:${i.market.asset}`;
      groups.set(key, [...(groups.get(key) ?? []), i]);
    }
    for (const [key, group] of groups) {
      const reads = await groupRead(group).catch(() => group.map(i => unknownPosition(i.market, i)));
      for (const p of reads) {
        if (p.state !== 'known' || p.claim === null || p.receipt === null || p.rate === null || p.scale === null) continue;
        try {
          if (p.claim === 0n) p.value = 0n;
          else if (p.market.asset === numeraire) p.value = p.claim;
          else {
            const quoted = await deps.batch(client, observation.block, [{ target: oracle, name: 'previewSwap', args: [p.market.asset, numeraire, p.claim] }]);
            if (!Array.isArray(quoted[0]) || quoted[0].length !== 2) throw unavailable();
            p.value = integer(quoted[0][0]); if (p.value === 0n) throw unavailable();
          }
          const i=group.find(i=>i.market.marketId===p.market.marketId);if(!i)throw unavailable();
          const syncCall:ReadCall={target:profile.registry,name:'quoteWithdraw',args:[p.market.marketId,p.market.protocol!=='aave_v3'&&p.receipt>0n?p.receipt:1n]};
          if(p.market.protocol==='venus'){
            const v=await deps.batch(client,observation.block,[syncCall,{target:p.market.target,name:'getCash'},
              {target:p.market.target,name:'totalReserves'},{target:i.riskSource,name:'actionPaused',args:[p.market.target,1]}]);
            if(v[0]===null||typeof v[3]!=='boolean')throw unavailable();
            p.withdrawPaused=v[3];const cash=integer(v[1]),reserves=integer(v[2]),liquidity=cash>reserves?cash-reserves:0n;
            const fullQuote=integer(v[0]);
            p.maxWithdraw=p.withdrawPaused?0n:min(p.claim,liquidity);
            // Converting a rounded-down full claim back to receipts can strand one raw unit.
            // Redeem every receipt only when the same-call protocol quote is fully liquid.
            p.maxRedeem=!p.withdrawPaused&&p.receipt>0n&&fullQuote>0n&&liquidity>=fullQuote
              ?p.receipt:min(p.receipt,p.maxWithdraw*p.scale/p.rate);
          }else if(p.market.protocol==='lista'){
            const v=await deps.batch(client,observation.block,[syncCall,{target:p.market.target,name:'maxWithdraw',args:[account]},
              {target:p.market.target,name:'maxRedeem',args:[account]},{target:i.riskSource,name:'paused'}]);
            if(v[0]===null||typeof v[3]!=='boolean')throw unavailable();p.withdrawPaused=v[3];
            const available=integer(v[1]),conservativeRedeem=integer(v[2]),fullQuote=integer(v[0]);
            p.maxWithdraw=p.withdrawPaused?0n:min(p.claim,available);
            // Reviewed MockLista/Moolah redeem enforces cash directly, not the rounded maxRedeem hint.
            p.maxRedeem=p.withdrawPaused?0n:p.receipt>0n&&fullQuote>0n&&available>=fullQuote
              ?p.receipt:min(p.receipt,conservativeRedeem);
          }else{
            const v=await deps.batch(client,observation.block,[syncCall,{target:p.market.asset,name:'balanceOf',args:[p.market.receipt]},
              {target:p.market.target,name:'getVirtualUnderlyingBalance',args:[p.market.asset]},
              {target:p.market.target,name:'getReserveData',args:[p.market.asset]}]);
            if(v[0]===null)throw unavailable();const config=integer(v[3]);
            p.withdrawPaused=(config&(1n<<56n))===0n||(config&(1n<<60n))!==0n;
            const cash=min(integer(v[1]),integer(v[2]));
            p.maxWithdraw=p.withdrawPaused?0n:min(p.claim,cash);p.maxRedeem=p.withdrawPaused?0n:min(p.receipt,cash);
          }
        } catch { Object.assign(p, unknownPosition(p.market)); }
      }
      positions.push(...reads);
      const valid = reads.every(p => p.state === 'known');
      const health = await healthRead(group).catch(() => null);
      // Exit health uses lenient accrued quotes, independently of supply rate admission.
      const keys = [key, ...new Set(group.flatMap(i => i.queues).map(id => `${key}:${id}`))];
      for (const bucket of keys) {
        const i = group[0]; if (!i) throw unavailable();
        risks.push({ ...observation, key: bucket, protocol: i.market.protocol, asset: i.market.asset, riskSource: i.riskSource,
          underlyingMarketId: bucket === key ? null : hash(bucket.slice(key.length + 1)), configuration: i.configuration,
          state: valid && health ? 'known' : 'unknown', reason: valid && health ? null : 'market_data_unavailable',
          supply: valid && health ? health.supply : null, liquidity: valid && health ? health.liquidity : null,
          exposure: valid && health ? health.exposure : null, externalReserved: valid && health ? health.reserved : null,
          headroom: valid && health ? health.headroom : null, utilizationBps: valid && health ? health.utilization : null });
      }
    }
    // Missing identities still get explicit unknown positions; never silently omit a market.
    for (const m of profile.markets) if (!positions.some(p => p.market.marketId === m.marketId)) positions.push(unknownPosition(m));
    let nav = await deps.batch(client, observation.block, [
      ...profile.markets.map((m): ReadCall => ({ target: profile.registry, name: 'refreshHealth', args: [m.marketId] })),
      { target: profile.executor, name: 'previewAccountValue', args: [account] },
    ]).then(values => { const value = values.at(-1); return value === null ? null : integer(value); }).catch(() => null);
    if(nav!==null){
      try{
        const enrolled=(await deps.batch(client,observation.block,[{target:strategyRegistry,name:'enrollments',args:[account]}]))[0];
        if(!Array.isArray(enrolled)||enrolled.length!==3)throw unavailable();
        // Executor values the effective history, independently of the enrollment's
        // immutable yield-policy version. Pin both reads to the NAV block.
        const assets=(await deps.batch(client,observation.block,[{target:strategyRegistry,name:'historicalAssets',args:[integer(enrolled[0])]}]))[0];
        if(!Array.isArray(assets)||assets.length>128)throw unavailable();
        const tokens=[...new Set([numeraire,...assets.map(address)])].filter(a=>!profile.markets.some(m=>m.receipt===a));
        const balances=await deps.batch(client,observation.block,tokens.map((token):ReadCall=>({target:token,name:'balanceOf',args:[account]})));
        let direct=0n;
        for(const [index,token]of tokens.entries()){
          const held=integer(balances[index]);if(held===0n)continue;
          if(token===numeraire)direct+=held;
          else {const quote=(await deps.batch(client,observation.block,[{target:oracle,name:'previewSwap',args:[token,numeraire,held]}]))[0];
            if(!Array.isArray(quote)||quote.length!==2||integer(quote[0])===0n)throw unavailable();direct+=integer(quote[0]);}
        }
        if(positions.some(p=>p.value===null)||direct+positions.reduce((n,p)=>n+(p.value??0n),0n)!==nav)throw unavailable();
      }catch{nav=null;}
    }
    if ((await client.getBlock({ blockNumber: observation.block })).hash !== observation.blockHash || !fresh(observation.at, deps.now())) throw unavailable();
    return { profile, positions, risks, accountValue: positions.some(p=>p.state==='unknown')?null:nav, observation };

    async function identity(m: YieldMarket): Promise<MarketIdentity | null> {
      try {
        const v = await deps.batch(client, observation.block, [
          { target: profile.registry, name: 'market', args: [m.marketId] },
          { target: profile.registry, name: 'totalUnits', args: [m.marketId] },
          { target: m.asset, name: 'decimals' }, { target: m.receipt, name: 'decimals' },
        ]);
        const r = object(v[0]);
        if (integer(r.chainId) !== 97n || num(r.kind) !== ({ venus: 1, lista: 2, aave_v3: 3 })[m.protocol] ||
          address(r.asset) !== m.asset || address(r.receipt) !== m.receipt || address(r.target) !== m.target ||
          typeof r.supplyEnabled !== 'boolean' || typeof r.retired !== 'boolean') throw unavailable();
        const queues: Hex[] = [];
        if (m.protocol === 'lista') {
          const lengths = await deps.batch(client, observation.block, [{ target: m.target, name: 'supplyQueueLength' }, { target: m.target, name: 'withdrawQueueLength' }]);
          const s = num(lengths[0]), w = num(lengths[1]);
          if (s < 1 || s > 16 || w > 16) throw unavailable();
          const entries = await deps.batch(client, observation.block, [
            ...Array.from({ length: s }, (_, n): ReadCall => ({ target: m.target, name: 'supplyQueue', args: [BigInt(n)] })),
            ...Array.from({ length: w }, (_, n): ReadCall => ({ target: m.target, name: 'withdrawQueue', args: [BigInt(n)] })),
          ]);
          queues.push(...new Set(entries.map(hash)));
        }
        const underlyingDecimals = num(v[2]), receiptDecimals = num(v[3]);
        if (underlyingDecimals > 255 || receiptDecimals > 255) throw unavailable();
        return { market: m, riskSource: address(r.riskSource), configuration: hash(r.configuration), totalUnits: integer(v[1]),
          minRate: integer(r.minRate), maxRate: integer(r.maxRate), retired:r.retired, supplyOpen: base[2]===false && r.supplyEnabled && !r.retired, underlyingDecimals, receiptDecimals, queues };
      } catch { return null; }
    }
    function unknownPosition(m: YieldMarket, i?: MarketIdentity): YieldPosition {
      return { ...observation, market: m, state: 'unknown', reason: 'market_data_unavailable', receipt: null, observedUnits: null, trackedUnits: null,
        claim: null, value: null, maxWithdraw: null, maxRedeem: null, rate: null, scale: null, aprBps: null, supplyOpen: false, exiting: true,
        underlyingDecimals: i?.underlyingDecimals ?? 0, receiptDecimals: i?.receiptDecimals ?? 0 };
    }
    function sync(group: MarketIdentity[]): ReadCall[] { return group.map(i => ({ target: profile.registry, name: 'refreshHealth', args: [i.market.marketId] })); }
    async function groupRead(group: MarketIdentity[]): Promise<YieldPosition[]> {
      const calls: ReadCall[] = sync(group);
      for (const i of group) {
        const m = i.market;
        calls.push({ target: profile.registry, name: 'quoteWithdraw', args: [m.marketId, 1n] },
          { target: m.receipt, name: 'balanceOf', args: [account] },
          { target: m.receipt, name: m.protocol === 'aave_v3' ? 'scaledBalanceOf' : 'balanceOf', args: [account] },
          { target: profile.registry, name: 'accountUnits', args: [account, m.marketId] },
          { target: profile.registry, name: 'receiptAssets', args: [m.marketId, account] },
          { target: m.protocol === 'aave_v3' ? m.target : m.receipt,
            name: m.protocol === 'venus' ? 'exchangeRateStored' : m.protocol === 'lista' ? 'convertToAssets' : 'getReserveNormalizedIncome',
            args: m.protocol === 'venus' ? [] : [m.protocol === 'lista' ? WAD : m.asset] },
          { target: m.protocol === 'aave_v3' ? m.receipt : m.target, name: 'aprBps' },
          { target: profile.registry, name: 'exiting', args: [account, m.marketId] });
      }
      const values = await deps.batch(client, observation.block, calls);
      return group.map((i, n) => {
        try {
          const offset = group.length + n * 8, v = values.slice(offset, offset + 8);
          if (v[0] === null || typeof v[7] !== 'boolean') throw unavailable();
          const receipt = integer(v[1]), units = integer(v[2]), tracked = integer(v[3]), claim = integer(v[4]), rate = integer(v[5]);
          const scale = i.market.protocol === 'aave_v3' ? RAY : WAD;
          if (integer(v[6])>1000000n || rate === 0n || units !== tracked || i.market.protocol === 'aave_v3' && receipt !== units * rate / RAY) throw unavailable();
          // NAV uses the executor's undiscounted quote; the 50 USDT supply minimum uses its floor.
          return { ...observation, market: i.market, state: 'known', reason: null, receipt, observedUnits: units, trackedUnits: tracked, claim,
            value: null, maxWithdraw: null, maxRedeem: null, rate, scale, aprBps: integer(v[6]), retired:i.retired, supplyOpen: i.supplyOpen && values[n] !== null,
            exiting: v[7], underlyingDecimals: i.underlyingDecimals, receiptDecimals: i.receiptDecimals };
        } catch { return unknownPosition(i.market, i); }
      });
    }
    async function healthRead(group: MarketIdentity[]) {
      const calls: ReadCall[] = group.map(i=>({target:profile.registry,name:'quoteWithdraw',args:[i.market.marketId,1n]}));
      for (const i of group) {
        const m = i.market;
        calls.push({target:profile.registry,name:'health',args:[m.marketId]},
          {target:profile.registry,name:'rateCheckpoint',args:[m.marketId]},
          {target:m.protocol==='aave_v3'?m.target:m.receipt,
            name:m.protocol==='venus'?'exchangeRateStored':m.protocol==='lista'?'convertToAssets':'getReserveNormalizedIncome',
            args:m.protocol==='venus'?[]:[m.protocol==='lista'?WAD:m.asset]},
          { target: m.protocol === 'aave_v3' ? m.target : m.receipt,
          name: m.protocol === 'venus' ? 'exchangeRateStored' : m.protocol === 'lista' ? 'totalAssets' : 'getReserveNormalizedIncome',
          args: m.protocol === 'aave_v3' ? [m.asset] : [] },
          { target: m.receipt, name: 'totalSupply' },
          { target: m.protocol === 'venus' ? i.riskSource : m.target,
            name: m.protocol === 'venus' ? 'supplyCaps' : m.protocol === 'lista' ? 'maxDeposit' : 'getReserveData',
            args: [m.protocol === 'venus' ? m.target : m.protocol === 'lista' ? account : m.asset] });
      }
      const v = await deps.batch(client, observation.block, calls);
      let supply = UINT256_MAX, liquidity = UINT256_MAX, exposure = 0n, headroom = UINT256_MAX, utilization = 0;
      for (const [n, i] of group.entries()) {
        const offset=group.length+n*6,h=object(v[offset]),checkpoint=v[offset+1];
        const currentRate=integer(v[offset+2]),rate=integer(v[offset+3]),receiptSupply=integer(v[offset+4]),cap=integer(v[offset+5]);
        const checkpointRate=i.market.protocol==='aave_v3'?currentRate/10n**9n:currentRate;
        if(v[n]===null||!Array.isArray(checkpoint)||checkpoint.length!==2||integer(checkpoint[0])===0n||
          integer(checkpoint[1])>block.timestamp||checkpointRate<integer(checkpoint[0]))throw unavailable();
        if (hash(h.configuration) !== i.configuration || integer(h.supply) === 0n || integer(h.utilizationBps) > 10000n) throw unavailable();
        supply = min(supply, integer(h.supply)); liquidity = min(liquidity, integer(h.liquidity)); utilization = Math.max(utilization, num(h.utilizationBps));
        if(i.market.protocol==='lista'&&i.totalUnits>0n&&receiptSupply===0n)throw unavailable();
        exposure += i.totalUnits===0n?0n:i.market.protocol === 'lista' ? ceil(i.totalUnits * (rate + 1n), receiptSupply) : ceil(i.totalUnits * rate, i.market.protocol === 'aave_v3' ? RAY : WAD);
        let available = cap;
        if (i.market.protocol === 'venus') available = cap === 0n ? UINT256_MAX : cap > integer(h.supply) ? cap - integer(h.supply) : 0n;
        if (i.market.protocol === 'aave_v3') {
          if (Number((cap >> 48n) & 255n) !== i.underlyingDecimals) throw unavailable();
          const whole = (cap >> 116n) & ((1n << 36n) - 1n), scaled = whole * 10n ** BigInt(i.underlyingDecimals);
          available = whole === 0n ? UINT256_MAX : scaled > receiptSupply ? scaled - receiptSupply : 0n;
        }
        headroom = min(headroom, available);
      }
      return { supply, liquidity, exposure, reserved: 0n, headroom, utilization };
    }
  }
}
