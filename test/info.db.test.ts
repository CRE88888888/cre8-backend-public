import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { after, test } from 'node:test';
import { closePool, getPool, migrate, query } from '../src/db.js';
import { saveInfoBatch } from '../src/info/store.js';
import { createInfoService, parseInfoFilters } from '../src/info/service.js';
import { readInfoCatalogue } from '../src/info/catalogue.js';
import type { InfoQuery } from '../src/info/catalogue.js';
import { parseFed } from '../src/info/collectors/fed.js';
import { parseBea } from '../src/info/collectors/bea.js';
import { BLS_SERIES, parseBls } from '../src/info/collectors/bls.js';
import { parseTreasury, treasuryUrl } from '../src/info/collectors/treasury.js';
import { parseFred } from '../src/info/collectors/fred.js';
import { parseSecSubmissions } from '../src/info/collectors/sec.js';
import { parseStrategyArticle } from '../src/info/collectors/strategy.js';
import { withInfoJobLock } from '../src/info/job.js';
import type { InfoBatch, InfoEvent } from '../src/info/types.js';
import { createDraftStore, createAnthropicDrafter, loadInfoDraftConfig } from '../src/info/drafter.js';
import { createInfoDraftJob } from '../src/info/draft-job.js';
import { createDraftState } from '../src/info/draft-state.js';
import { createServer } from '../src/server.js';
import { UnauthorizedError } from '../src/errors.js';
import { MemoryRateLimitStore, RequestRateLimiter } from '../src/ratelimit.js';
import { loadRateLimitConfig } from '../src/config.js';

after(closePool);
const fixture = (name: string) => readFile(new URL(`./fixtures/info/${name}`, import.meta.url), 'utf8');
const owner = '0x0000000000000000000000000000000000000159';
const event = (ref: string): InfoEvent => ({ category: 'company', kind: 'sec_8k', source: 'test159', sourceRef: ref,
  occurredAt: '2026-11-20T00:00:00.000Z', titleEn: 'Source event', assetSymbols: ['NVDA'],
  sourceUrl: 'https://www.sec.gov/Archives/test', actual: '0.000', payload: { period: '2026-11' } });

async function database(action: (run: InfoQuery, save: (batch: InfoBatch) => ReturnType<typeof saveInfoBatch>) => Promise<void>) {
  await migrate();
  const client = await getPool().connect();
  try {
    await client.query('begin');
    const run: InfoQuery = (sql, params) => client.query(sql, [...(params ?? [])]);
    await action(run, batch => saveInfoBatch(batch, fn => fn(client)));
  } finally { await client.query('rollback'); client.release(); }
}

test('#159 every recorded collector batch uses database uniqueness on replay, and preserves exact market numbers', async () => {
  const strategy = parseStrategyArticle(await fixture('strategy-article.html'), 'https://www.strategy.com/press/test159');
  const batches = [parseFed(await fixture('fed.xml')), parseBea(await fixture('bea.xml')), parseBls(await fixture('bls.json'), BLS_SERIES[0]),
    parseTreasury(await fixture('treasury.xml'), treasuryUrl(2026)), parseFred(await fixture('fred.csv')),
    { events: parseSecSubmissions(await fixture('sec-submissions.json'), '0000320193', ['AAPL']), markets: [] }, { events: [strategy], markets: [] }];
  await database(async (run, save) => {
    for (const batch of batches) {
      const scoped = { ...batch, events: batch.events.map(item => ({ ...item, sourceRef: `${item.sourceRef}:${randomUUID()}` })) };
      const first = await save(scoped);
      assert.equal(first.events, scoped.events.length);
      assert.deepEqual(await save(scoped), { events: 0, markets: 0 });
    }
    const actual = (await run("select actual from info_events where source='bls'")).rows;
    assert.ok(actual.every(row => typeof row.actual === 'string'));
    assert.ok((await run("select value::text from market_snapshots where series='usd_broad'")).rows.some(row => row.value === '122.6503'));
  });
});

test('#159 collected corrections update source fields; reviewed/published/rejected text and facts remain frozen after recollection', async () => {
  await database(async (run, save) => {
    const source = event(randomUUID());
    await save({ events: [source], markets: [] });
    const corrected = { ...source, actual: '-1.2340' };
    assert.equal((await save({ events: [corrected], markets: [] })).events, 1);
    const row = (await run('select id::text,actual,status from info_events where source=$1 and source_ref=$2', [source.source, source.sourceRef])).rows[0];
    assert.ok(row); assert.equal(row.actual, '-1.2340'); assert.equal(row.status, 'collected');
    const service = createInfoService({ query: run, catalogue: async () => [] });
    for (const status of ['reviewed', 'published', 'rejected']) {
      await service.review(String(row.id), { title_zh: `人工標題 ${status}`, status }, owner);
      assert.deepEqual(await save({ events: [{ ...source, titleEn: 'Changed after review', actual: '999' }], markets: [] }), { events: 0, markets: 0 });
      const preserved: Record<string, unknown> | undefined = (await run('select title_zh,actual,status,reviewed_by,reviewed_at from info_events where id=$1', [row.id])).rows[0];
      assert.ok(preserved); assert.equal(preserved.actual, '-1.2340'); assert.equal(preserved.title_zh, `人工標題 ${status}`);
      assert.equal(preserved.status, status); assert.equal(preserved.reviewed_by, owner); assert.ok(preserved.reviewed_at instanceof Date);
    }
  });
});

test('#159 real catalogue joins assets and current active public version; API filters at equality, publication, fund and limit', async () => {
  await database(async (run, save) => {
    const name = `info159-${randomUUID()}`;
    const fund = (await run('insert into strategies(provider,name) values($1,$2) returning id::text', [owner, name])).rows[0]; assert.ok(fund);
    const id = String(fund.id);
    const allocation = { assets: [{ address: '0x0000000000000000000000000000000000000159', symbol: 'NVDAB', weightBps: 10000 }] };
    await run("insert into strategy_versions(strategy_id,version,allocation,schedule,active_at) values($1,1,$2,'{}',now()-interval '1 day')", [id, JSON.stringify(allocation)]);
    const pending = { assets: [{ ...allocation.assets[0], symbol: 'AAPLB' }] };
    await run("insert into strategy_versions(strategy_id,version,allocation,schedule,active_at) values($1,2,$2,'{}',now()+interval '1 day')", [id, JSON.stringify(pending)]);
    const funds = await readInfoCatalogue(run, 56);
    assert.deepEqual(funds.find(item => item.id === id), { id, name, assetSymbols: ['NVDAB'] });
    const service = createInfoService({ query: run, catalogue: async () => funds });
    const first = event(randomUUID()), second = { ...event(randomUUID()), category: 'person' as const, assetSymbols: ['BTC'] };
    await save({ events: [first, second], markets: [] });
    const events = (await run('select id::text from info_events where source=$1 and source_ref=any($2::text[]) order by id', [first.source, [first.sourceRef, second.sourceRef]])).rows;
    const params = new URLSearchParams({ fund: id, from: first.occurredAt, to: first.occurredAt, category: 'company', limit: '1' });
    assert.equal((await service.events(parseInfoFilters(params))).events.length, 0);
    params.set('include', 'collected');
    const collected = (await service.events(parseInfoFilters(params))).events;
    assert.equal(collected.length, 1); assert.ok(collected[0]?.affectedFunds.some(item => item.id === id));
    await service.review(String(events[0]?.id), { title_zh: '已確認的公告', status: 'published' }, owner);
    params.delete('include');
    assert.equal((await service.events(parseInfoFilters(params))).events.length, 1);
    params.set('category', 'person'); assert.equal((await service.events(parseInfoFilters(params))).events.length, 0);
    params.set('fund', '9223372036854775807'); params.delete('category'); assert.equal((await service.events(parseInfoFilters(params))).events.length, 0);
  });
});

test('#159 company ticker collisions never match crypto funds in SQL or affectedFunds; BLS public API keeps its time basis', async () => {
  await database(async (run, save) => {
    const service = createInfoService({ query: run, catalogue: async () => [{ id: '159', name: 'Crypto', assetSymbols: ['TRX', 'BCH', 'BNB', 'BTCB'] }] });
    const company = { ...event(randomUUID()), assetSymbols: ['TRX', 'BCH'] };
    const person = { ...event(randomUUID()), category: 'person' as const, assetSymbols: ['BTC'] };
    const bls = parseBls(await fixture('bls.json'), BLS_SERIES[0]).events[0]; assert.ok(bls);
    const observation = { ...bls, sourceRef: randomUUID() };
    await save({ events: [company, person, observation], markets: [] });
    for (const source of [company, person, observation]) {
      const row = (await run('select id::text from info_events where source=$1 and source_ref=$2', [source.source, source.sourceRef])).rows[0]; assert.ok(row);
      await service.review(String(row.id), { title_zh: '人工標題', status: 'published' }, owner);
    }
    const filtered = await service.events(parseInfoFilters(new URLSearchParams({ fund: '159' })));
    assert.equal(filtered.events.length, 1); assert.equal(filtered.events[0]?.category, 'person');
    const all = await service.events(parseInfoFilters(new URLSearchParams()));
    assert.deepEqual(all.events.find(row => row.sourceRef === company.sourceRef)?.affectedFunds, []);
    const actual = all.events.find(row => row.sourceRef === observation.sourceRef); assert.ok(actual);
    assert.equal(actual.timeBasis, 'reference_period_end'); assert.equal(actual.releaseDateAvailable, false);
    assert.equal(actual.referencePeriod, observation.payload.referencePeriod);
  });
});

test('#159 market SQL returns exactly the newest two dates and exact difference even for zero/negative values', async () => {
  await database(async (run, save) => {
    for (const [observedOn, value] of [['2099-01-01', '0.0000'], ['2099-01-02', '-0.0100'], ['2099-01-03', '-0.0100']]) {
      assert.ok(observedOn && value);
      await save({ events: [], markets: [{ series: 'ust_2y', observedOn, value, source: 'treasury', sourceUrl: treasuryUrl(2026) }] });
    }
    const service = createInfoService({ query: run });
    const market = (await service.markets()).markets.find(row => row.series === 'ust_2y'); assert.ok(market);
    assert.equal(market.points.length, 2); assert.equal(market.change, '0.0000');
    assert.deepEqual(market.points.map(point => point.observedOn), ['2099-01-03', '2099-01-02']);
    await save({ events: [], markets: [{ series: 'ust_2y', observedOn: '2099-01-03', value: '-0.0200', source: 'treasury', sourceUrl: treasuryUrl(2026) }] });
    assert.equal((await service.markets()).markets.find(row => row.series === 'ust_2y')?.change, '-0.0100');
  });
});

test('#159 source batch DB failure rolls back its earlier events, never leaving a partially stored batch', async () => {
  await migrate();
  const source = event(randomUUID());
  await assert.rejects(saveInfoBatch({ events: [source], markets: [{ series: 'ust_2y', observedOn: '2026-11-20', value: 'broken', source: 'treasury', sourceUrl: treasuryUrl(2026) }] }));
  assert.equal((await query('select id from info_events where source=$1 and source_ref=$2', [source.source, source.sourceRef])).rows.length, 0);
});

test('#159 job lock excludes a second connection, releases after callback failure and is reusable', async () => {
  await migrate();
  let acquired = () => {}, release = () => {};
  const entered = new Promise<void>(resolve => { acquired = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const first = withInfoJobLock(async () => { acquired(); await released; });
  await entered;
  try { await withInfoJobLock(async () => assert.fail('concurrent collector entered')); }
  finally { release(); await first; }
  await assert.rejects(withInfoJobLock(async () => { throw new Error('callback failed'); }), /callback failed/);
  let next = 0; await withInfoJobLock(async () => { next++; }); assert.equal(next, 1);
});

test('#165 real SQL drafts collected rows once, preserves original facts, and requires SIWE operator review before public HTTP visibility', async () => {
  await database(async (run, save) => {
    const source = event(randomUUID()); await save({ events: [source], markets: [] });
    const store = createDraftStore(run), service = createInfoService({ query: run, catalogue: async () => [] });
    const rows = await store.collected('0', 100);
    const pending = rows.find(row => row.source_ref === source.sourceRef); assert.ok(pending);
    const pendingId = pending.id;
    const title = '公司公告；實際：0.000；預期查不到';
    const config = loadInfoDraftConfig({ INFO_DRAFT_ENABLED: '1', ANTHROPIC_API_KEY: 'mock-db-only-credential' }); assert.ok(config);
    const draft = await createAnthropicDrafter(config, async () => new Response(JSON.stringify({ stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify({ title_zh: title }) }] })))(pending);
    assert.equal(await store.save(pending, draft), true); assert.equal(await store.save(pending, '不能重寫'), false);
    assert.ok(!(await store.collected('0', 100)).some(row => row.id === pending.id));
    const persisted = (await run('select * from info_events where id=$1', [pending.id])).rows[0]; assert.ok(persisted);
    assert.equal(persisted.status, 'drafted'); assert.equal(persisted.reviewed_by, null); assert.equal(persisted.reviewed_at, null);
    assert.equal(persisted.actual, source.actual); assert.equal(persisted.title_en, source.titleEn); assert.deepEqual(persisted.payload, source.payload);
    // Recollection follows #161's existing freeze behavior for drafted and human-reviewed events.
    assert.equal((await save({ events: [{ ...source, titleEn: 'Changed after draft', actual: '999' }], markets: [] })).events, 0);
    const server = createServer({ info: service, operatorWallets: [owner], operatorRebalanceEnabled: () => false,
      rateLimiter: new RequestRateLimiter(loadRateLimitConfig({}), new MemoryRateLimitStore()),
      auth: { authenticate: async header => { if (!header) throw new UnauthorizedError(); return header === 'Bearer operator' ? owner : '0x0000000000000000000000000000000000000165'; },
        issueNonce: () => { throw new Error('unused'); }, login: async () => { throw new Error('unused'); }, logout: async () => {} } });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}`;
    async function readEvents(suffix = '', authorization?: string) {
      const result = await fetch(`${url}/info/events${suffix}`, { headers: authorization ? { authorization } : {} });
      const body: unknown = await result.json(); assert.ok(typeof body === 'object' && body !== null);
      const events: unknown = Reflect.get(body, 'events'); assert.ok(Array.isArray(events));
      return events.filter((row: unknown): row is Record<string, unknown> => typeof row === 'object' && row !== null)
        .find(row => row.id === pendingId);
    }
    try {
      assert.equal(await readEvents(), undefined);
      assert.equal((await fetch(url + '/info/events?include=collected')).status, 401);
      assert.equal((await fetch(url + '/info/events?include=collected', { headers: { authorization: 'Bearer other' } })).status, 403);
      const visible = await readEvents('?include=collected', 'Bearer operator'); assert.ok(visible);
      assert.equal(visible.status, 'drafted'); assert.equal(visible.titleZh, title); assert.equal(visible.titleEn, source.titleEn);
      assert.equal(visible.actual, source.actual); assert.equal(visible.expected, null);
      const reviewUrl = `${url}/operator/info/events/${pending.id}/review`;
      for (const [authorization, status] of [[undefined, 401], ['Bearer other', 403]] as const) {
        assert.equal((await fetch(reviewUrl, { method: 'POST', headers: authorization ? { authorization } : {}, body: '{}' })).status, status);
      }
      assert.equal((await fetch(reviewUrl, { method: 'POST', headers: { authorization: 'Bearer operator', 'content-type': 'application/json' },
        body: JSON.stringify({ title_zh: '人工確認的公告', status: 'published' }) })).status, 200);
      const published = await readEvents(); assert.ok(published); assert.equal(published.titleZh, '人工確認的公告');
      assert.equal(await store.save(pending, title), false);
      const reviewed = (await run('select reviewed_by,reviewed_at,status from info_events where id=$1', [pending.id])).rows[0]; assert.ok(reviewed);
      assert.equal(reviewed.status, 'published'); assert.equal(reviewed.reviewed_by, owner); assert.ok(reviewed.reviewed_at instanceof Date);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
});

test('#165 source corrections and human reviewed/published/rejected races cannot be overwritten by delayed drafts', async () => {
  await database(async (run, save) => {
    const source = event(randomUUID()); await save({ events: [source], markets: [] });
    const store = createDraftStore(run), service = createInfoService({ query: run, catalogue: async () => [] });
    const pending = (await store.collected('0', 100)).find(row => row.source_ref === source.sourceRef); assert.ok(pending);
    // now() is identical within this transaction: compare the source fields in addition to the timestamp.
    assert.equal((await save({ events: [{ ...source, actual: '-1.2300' }], markets: [] })).events, 1);
    assert.equal(await store.save(pending, '過期的來源'), false);
    const corrected = (await store.collected('0', 100)).find(row => row.id === pending.id); assert.ok(corrected);
    for (const status of ['reviewed', 'published', 'rejected']) {
      await service.review(pending.id, { title_zh: `人工標題 ${status}`, status }, owner);
      assert.equal(await store.save(corrected, '不應覆蓋'), false);
      assert.ok(!(await store.collected('0', 100)).some(row => row.id === pending.id));
      const row: Record<string, unknown> | undefined = (await run('select title_zh,status,reviewed_by,actual from info_events where id=$1', [pending.id])).rows[0]; assert.ok(row);
      assert.equal(row.title_zh, `人工標題 ${status}`); assert.equal(row.status, status); assert.equal(row.reviewed_by, owner); assert.equal(row.actual, '-1.2300');
    }
  });
});

test('#165 mock API format/429/timeout failures leave real DB status and source payload unchanged', async () => {
  await database(async (run, save) => {
    await mkdir('.bun-cache/info165', { recursive: true });
    const directory = await mkdtemp(path.resolve('.bun-cache/info165/db-'));
    try {
      const source = event(randomUUID()); await save({ events: [source], markets: [] });
      const store = createDraftStore(run), config = loadInfoDraftConfig({ INFO_DRAFT_ENABLED: '1', ANTHROPIC_API_KEY: 'mock-db-only-credential' }); assert.ok(config);
      const pending = (await store.collected('0', 100)).find(row => row.source_ref === source.sourceRef); assert.ok(pending);
      let clock = Date.parse('2026-11-20T00:00:00Z');
      const sends: ((url: string, init: RequestInit) => Promise<Response>)[] = [async () => new Response('{}'),
        async () => new Response('private upstream body', { status: 429 }),
        async (_url, init) => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('private')), { once: true }))];
      for (const send of sends) {
        const job = createInfoDraftJob({ env: { INFO_DRAFT_ENABLED: '1', ANTHROPIC_API_KEY: config.key }, lock: action => action(),
          state: createDraftState(directory), now: () => new Date(clock), log: () => {},
          store: { ...store, collected: async after => after === '0' ? [pending] : [] }, draft: createAnthropicDrafter(config, send, 5) });
        assert.equal((await job()).failed, 1);
        const row: Record<string, unknown> | undefined = (await run('select status,title_zh,reviewed_at,payload from info_events where id=$1', [pending.id])).rows[0]; assert.ok(row);
        assert.equal(row.status, 'collected'); assert.equal(row.title_zh, null); assert.equal(row.reviewed_at, null); assert.deepEqual(row.payload, source.payload);
        clock += 3_600_000;
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
