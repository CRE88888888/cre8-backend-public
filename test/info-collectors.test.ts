import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fedCollector, parseFed } from '../src/info/collectors/fed.js';
import { beaCollector, parseBea } from '../src/info/collectors/bea.js';
import { blsCollector, BLS_POLL_MS, BLS_SERIES, parseBls } from '../src/info/collectors/bls.js';
import { fredCollector, parseFred } from '../src/info/collectors/fred.js';
import { treasuryCollector, parseTreasury, treasuryUrl } from '../src/info/collectors/treasury.js';
import { parseSecTickers, parseSecSubmissions, secCollector } from '../src/info/collectors/sec.js';
import { parseStrategyArticle, strategyCollector, strategyLinks } from '../src/info/collectors/strategy.js';
import { createInfoGet, MAX_SOURCE_BYTES, sourceUrl } from '../src/info/source.js';
import { reserveBlsRequest } from '../src/info/quota.js';
import { createInfoJob, createInfoWorker, loadInfoConfig, runInfoCollectors } from '../src/info/job.js';
import { InfoSourceError } from '../src/info/types.js';
import type { InfoBatch, InfoGet } from '../src/info/types.js';

const fixture = (name: string) => readFile(new URL(`./fixtures/info/${name}`, import.meta.url), 'utf8');
const now = () => new Date('2026-11-20T00:00:00Z');
const empty = (): InfoBatch => ({ events: [], markets: [] });
const save = async (batch: InfoBatch) => ({ events: batch.events.length, markets: batch.markets.length });

test('#159 recorded Fed/BEA feeds classify statement/minutes and national GDP/PCE separately', async () => {
  const fed = parseFed(await fixture('fed.xml'));
  assert.equal(fed.events.length, 4);
  assert.equal(fed.events[0]?.kind, 'fomc_minutes');
  assert.equal(fed.events[2]?.kind, 'fomc_statement');
  assert.equal(fed.events[2]?.occurredAt, '2026-10-28T18:00:00.000Z');
  assert.ok(fed.events.every(event => event.category === 'economy' && event.sourceUrl.startsWith('https://www.federalreserve.gov/')));
  const bea = parseBea(await fixture('bea.xml'));
  assert.deepEqual(bea.events.map(event => event.kind), ['gdp', 'pce']);
  assert.equal(bea.events[1]?.occurredAt, '2026-10-29T12:30:00.000Z');
  assert.deepEqual(parseBea('<rss><channel><item><title>Gross Domestic Product by State, 2026</title></item></channel></rss>').events, []);
  assert.match(bea.events[1]?.titleEn ?? '', /Personal Income/);
});

test('#159 recorded BEA scheme-less official links normalize safely; territory/metropolitan/industry GDP stay excluded', async () => {
  const batch = parseBea(await fixture('bea-edge.xml'));
  assert.equal(batch.events.length, 1);
  assert.equal(batch.events[0]?.sourceUrl, 'https://www.bea.gov/news/2026/gdp-advance-estimate-4th-quarter-and-year-2025');
});

test('#159 BLS recorded observations retain exact values, reference period and units; never invent release date or consensus', async () => {
  const names = ['bls.json', 'bls-payrolls.json', 'bls-unemployment.json'];
  for (const [index, spec] of BLS_SERIES.entries()) {
    const batch = parseBls(await fixture(names[index] ?? ''), spec);
    assert.equal(batch.events.length, 1);
    const event = batch.events[0]; assert.ok(event);
    assert.equal(event.unit, spec.unit); assert.equal(event.payload.releaseDateAvailable, false);
    assert.equal(event.payload.timeBasis, 'reference_period_end');
    assert.match(event.sourceRef, new RegExp(`^${spec.id}:2026-`));
    assert.equal(typeof event.actual, 'string');
    assert.ok(!('expected' in event));
  }
  const spec = BLS_SERIES[0];
  const response = (data: unknown[]) => JSON.stringify({ status: 'REQUEST_SUCCEEDED', Results: { series: [{ seriesID: spec.id, data }] } });
  assert.deepEqual(parseBls(response([]), spec).events, []);
  assert.deepEqual(parseBls(response([{ year: '2026', period: 'M13', value: '9' }]), spec).events, []);
  assert.equal(parseBls(response([{ year: '2026', period: 'M01', value: '0.000' }, { year: '2025', period: 'M12', value: '5' }]), spec).events[0]?.actual, '0.000');
  assert.throws(() => parseBls(response([{ year: 'bad', period: 'M01', value: '0' }]), spec), /invalid_date/);
  assert.throws(() => parseBls(response([{ year: '2026', period: 'M01', value: 'missing' }]), spec), /invalid_number/);
  assert.throws(() => parseBls('{"status":"REQUEST_NOT_PROCESSED"}', spec), /bls_request_failed/);
  assert.throws(() => parseBls('{"status":"REQUEST_SUCCEEDED","Results":{"series":[]}}', spec), /bls_series_missing/);
});

test('#159 recorded Treasury/FRED data return last two actual observations per series without replacing missing days', async () => {
  const treasury = parseTreasury(await fixture('treasury.xml'), treasuryUrl(2026));
  assert.equal(treasury.markets.length, 4);
  assert.ok(treasury.markets.every(point => ['ust_2y', 'ust_10y'].includes(point.series) && /^\d\.\d{2}$/.test(point.value)));
  const fred = parseFred(await fixture('fred.csv'));
  assert.deepEqual(fred.markets.map(point => [point.observedOn, point.value]), [['2026-11-13', '122.6503'], ['2026-11-12', '122.5433']]);
  assert.equal(parseFred('DATE,DTWEXBGS\n2026-01-01,0\n2026-01-02,-1.2300\n').markets[0]?.value, '-1.2300');
  assert.deepEqual(parseFred('DATE,DTWEXBGS\n2026-01-01,.\n').markets, []);
  assert.throws(() => parseFred('DATE,DXY\n2026-01-01,1'), /invalid_csv/);
  for (const line of ['2026-02-30,1', '2026-01-01,nan', '2026-01-01,1,2']) assert.throws(() => parseFred(`DATE,DTWEXBGS\n${line}`));
  const missing = '<feed><entry><content><properties><NEW_DATE>2026-01-01T00:00:00</NEW_DATE><BC_2YEAR m:null="true" xmlns:m="urn:m"/><BC_10YEAR>0.00</BC_10YEAR></properties></content></entry></feed>';
  assert.deepEqual(parseTreasury(missing, treasuryUrl(2026)).markets.map(row => [row.series, row.value]), [['ust_10y', '0.00']]);
  const calls: string[] = [];
  const collector = treasuryCollector(async url => { calls.push(url); return url.endsWith('2026') ? '<feed/>' : await fixture('treasury.xml'); }, () => new Date('2026-01-01T00:00:00Z'));
  assert.equal((await collector.collect()).markets.length, 4);
  assert.equal(calls.length, 2);
});

test('#159 recorded SEC ticker/submissions map CIK and amendments, skip funds; do not infer Form 4 trades', async () => {
  const tickers = parseSecTickers(await fixture('sec-tickers.json'));
  assert.equal(tickers.get('AAPL'), '0000320193');
  const raw = await fixture('sec-submissions.json');
  const events = parseSecSubmissions(raw, '0000320193', ['AAPL']);
  assert.equal(events.length, 6); assert.ok(events.some(event => event.kind === 'sec_form4'));
  assert.ok(events.some(event => event.kind === 'sec_8k'));
  assert.ok(events.every(event => event.sourceUrl.includes(`/320193/${event.sourceRef.replaceAll('-', '')}/`) && event.actual === undefined));
  assert.deepEqual(parseSecSubmissions(raw.replace('"operating"', '"other"'), '0000320193', ['AAPL']), []);
  assert.throws(() => parseSecSubmissions(raw, '0000789019', ['MSFT']), /sec_cik_mismatch/);
  const parsed: unknown = JSON.parse(raw);
  assert.ok(typeof parsed === 'object' && parsed !== null);
  const broken = raw.replace('"4",', '"4/A",');
  assert.equal(parseSecSubmissions(broken, '0000320193', ['AAPL'])[0]?.payload.amendment, true);
  assert.throws(() => parseSecSubmissions(raw.replace(/"accessionNumber": \[/, '"accessionNumber": ["bad",'), '0000320193', []), /sec_array_mismatch/);
  assert.throws(() => parseSecTickers('{"0":{"ticker":"AAPL","cik_str":0}}'), /invalid_cik/);
  let reads = 0;
  await assert.rejects(secCollector(async () => { reads++; return ''; }, null, async () => []).collect(), /disabled_missing_sec_user_agent/);
  assert.equal(reads, 0);
  const urls: string[] = [], headersSeen: unknown[] = [];
  const get: InfoGet = async (url, headers) => { urls.push(url); headersSeen.push(headers); return fixture(url.includes('company_tickers') ? 'sec-tickers.json' : 'sec-submissions.json'); };
  const batch = await secCollector(get, 'CRE8 research bot', async () => [{ id: '1', name: 'Fund', assetSymbols: ['AAPLB', 'AAPL', 'BTC', 'UNKNOWN'] }], async () => {}).collect();
  assert.equal(urls.length, 2); assert.equal(batch.events.length, 6);
  assert.deepEqual(batch.events[0]?.assetSymbols, ['AAPL']);
  assert.deepEqual(headersSeen, [{ 'User-Agent': 'CRE8 research bot' }, { 'User-Agent': 'CRE8 research bot' }]);
  let collisionReads = 0;
  const collisions = '{"0":{"cik_str":1173643,"ticker":"TRX"},"1":{"cik_str":1161125,"ticker":"BCH"}}';
  const crypto = await secCollector(async () => { collisionReads++; return collisions; }, 'CRE8 research bot',
    async () => [{ id: '1', name: 'Crypto', assetSymbols: ['TRX', 'BCH', 'BTCB', 'WBNB', 'BNB', 'USDT'] }], async () => {}).collect();
  assert.equal(collisionReads, 0); assert.deepEqual(crypto.events, []);
  const tokenCollisionUrls: string[] = [];
  await secCollector(async url => {
    tokenCollisionUrls.push(url);
    return url.includes('company_tickers') ? '{"0":{"ticker":"AAPL","cik_str":320193},"1":{"ticker":"AAPLB","cik_str":999}}' : raw;
  }, 'CRE8 research bot', async () => [{ id: '1', name: 'Apple', assetSymbols: ['AAPLB', 'AAPLon'] }], async () => {}).collect();
  assert.equal(tokenCollisionUrls.length, 2);
  assert.match(tokenCollisionUrls[1] ?? '', /CIK0000320193/);
  assert.deepEqual(parseSecSubmissions('{"cik":320193,"entityType":"operating","filings":{"recent":{"form":[],"accessionNumber":[],"primaryDocument":[],"acceptanceDateTime":[]}}}', '0000320193', ['AAPL']), []);
});

test('#159 Strategy structural fixtures collect purchase articles only, require source date and cannot treat cumulative holdings as a purchase', async () => {
  const archive = await fixture('strategy.html'), article = await fixture('strategy-article.html');
  const urls = strategyLinks(archive); assert.equal(urls.length, 1);
  const url = urls[0]; assert.ok(url);
  const event = parseStrategyArticle(article, url);
  assert.deepEqual(event.assetSymbols, ['MSTR', 'BTC']); assert.equal(event.kind, 'btc_purchase');
  assert.equal(event.occurredAt, '2026-10-12T00:00:00.000Z');
  assert.equal((await strategyCollector(async request => request.endsWith('/press') ? archive : article).collect()).events.length, 1);
  assert.throws(() => parseStrategyArticle('<html/>', url), /strategy_article_missing_metadata/);
  const rendered = parseStrategyArticle('<html><h1>Strategy Acquires 250 BTC</h1><p>Press Release • October 12, 2026</p></html>', url);
  assert.equal(rendered.occurredAt, '2026-10-12T00:00:00.000Z'); assert.equal(rendered.payload.timeBasis, 'source_publication_date');
  assert.equal(parseStrategyArticle('<html><h1>Strategy Acquires 250 BTC</h1><time datetime="2026-10-12T08:00:00Z"></time></html>', url).occurredAt, '2026-10-12T08:00:00.000Z');
  assert.throws(() => strategyLinks('not html'), /invalid_html/);
  assert.deepEqual(strategyLinks('<html><a href="/press/holds-btc">Strategy Now Holds 843,738 BTC</a></html>'), []);
});

test('#159 each collector isolates network/403/429/malformed/empty responses, without logging unsafe messages', async () => {
  const makers = (get: InfoGet) => [fedCollector(get), beaCollector(get), blsCollector(get, async () => true), treasuryCollector(get, now), fredCollector(get),
    secCollector(get, 'CRE8 research bot', async () => [{ id: '1', name: 'Fund', assetSymbols: ['AAPL'] }], async () => {}), strategyCollector(get)];
  for (const error of [new Error('SECRET_DATABASE_URL'), new InfoSourceError('http_403'), new InfoSourceError('http_429'), new InfoSourceError('timeout')]) {
    const logs: unknown[] = [];
    const results = await runInfoCollectors(makers(async () => { throw error; }), save, row => logs.push(row));
    assert.equal(results.length, 7); assert.ok(results.every(row => row.error !== null));
    assert.doesNotMatch(JSON.stringify(logs), /SECRET_DATABASE_URL/);
  }
  const malformed = await runInfoCollectors(makers(async () => 'broken'), save, () => {});
  assert.ok(malformed.every(row => row.error !== null));
  assert.deepEqual(parseFed('<rss><channel/></rss>').events, []);
  assert.deepEqual(parseBea('<rss><channel/></rss>').events, []);
  assert.deepEqual(parseTreasury('<feed/>', treasuryUrl(2026)).markets, []);
  for (const raw of ['', '<html/>', '<rss><channel>', '<!DOCTYPE x><rss><channel/></rss>']) assert.throws(() => parseFed(raw));
  assert.throws(() => parseFed('<rss><channel><item><title>Missing fields</title></item></channel></rss>'), /missing_field/);
  let sent = 0;
  await assert.rejects(blsCollector(async () => { sent++; return ''; }, async () => false).collect(), /bls_daily_limit/);
  assert.equal(sent, 0);
  const results = await runInfoCollectors([{ name: 'failed', collect: async () => { throw new Error('secret'); } }, { name: 'next', collect: async () => empty() }], save, () => {});
  assert.equal(results[1]?.error, null);
  const failedDb = await runInfoCollectors([{ name: 'one', collect: async () => empty() }, { name: 'two', collect: async () => empty() }], async () => { throw new Error('secret'); }, () => {});
  assert.deepEqual(failedDb.map(row => row.error), ['dependency_unavailable', 'dependency_unavailable']);
});

test('#159 GET boundary enforces hosts, redirects, bytes, errors and timeout; exact size limit is allowed', async () => {
  for (const raw of ['http://www.sec.gov/a', 'https://www.sec.gov.evil/a', 'https://user:secret@www.sec.gov/a', 'https://127.0.0.1/a', 'https://www.sec.gov:444/a']) assert.throws(() => sourceUrl(raw));
  const url = 'https://www.sec.gov/files/company_tickers.json';
  const seen: RequestInit[] = [];
  const get = createInfoGet(async (_url, init) => { seen.push(init); return new Response('ok'); });
  assert.equal(await get(url), 'ok'); assert.equal(seen[0]?.method, 'GET'); assert.equal(seen[0]?.redirect, 'manual');
  for (const status of [403, 429, 500]) await assert.rejects(createInfoGet(async () => new Response('secret', { status }))(url), new RegExp(`http_${status}`));
  await assert.rejects(createInfoGet(async () => { throw new Error('private url'); })(url), /network_unavailable/);
  await assert.rejects(createInfoGet(async (_u, init) => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('abort')), { once: true })), 5)(url), /timeout/);
  assert.equal((await createInfoGet(async () => new Response('x'.repeat(MAX_SOURCE_BYTES)))(url)).length, MAX_SOURCE_BYTES);
  await assert.rejects(createInfoGet(async () => new Response('x'.repeat(MAX_SOURCE_BYTES + 1)))(url), /response_too_large/);
  await assert.rejects(createInfoGet(async () => new Response('x', { headers: { 'content-length': String(MAX_SOURCE_BYTES + 1) } }))(url), /response_too_large/);
  await assert.rejects(createInfoGet(async () => new Response(null, { status: 302, headers: { location: 'https://data.sec.gov/private' } }))(url), /invalid_source_url/);
  await assert.rejects(createInfoGet(async () => new Response(null, { status: 302, headers: { location: url } }))(url), /redirect_limit/);
  let clock = 0;
  const bounded = createInfoGet(async () => new Response('ok'), 15, 30, () => clock);
  assert.equal(await bounded(url), 'ok'); clock = 30;
  await assert.rejects(bounded(url), /source_deadline/);
});

test('#159 BLS polling spans the whole day instead of exhausting its daily allowance before releases', async () => {
  let clock = 0, reads = 0, reserved = 0;
  const collector = blsCollector(async url => {
    reads++;
    return fixture(url.endsWith('CUSR0000SA0') ? 'bls.json' : url.endsWith('CES0000000001') ? 'bls-payrolls.json' : 'bls-unemployment.json');
  }, async () => { reserved++; return true; }, () => clock);
  assert.equal((await collector.collect()).events.length, 3);
  for (let hour = 0; hour < 24; hour++) { clock = hour * 3600000; await collector.collect(); }
  assert.equal(reads, 18); assert.equal(reserved, 18);
  clock = 24 * 3600000 - 1; assert.equal((await collector.collect()).events.length, 0);
  clock++; assert.equal((await collector.collect()).events.length, 3);
  assert.equal(BLS_POLL_MS, 14400000);
});

test('#159 worker starts one background round without awaiting it, drains on stop and isolates failures', async () => {
  let release = () => {}, calls = 0, errors = 0;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const worker = createInfoWorker(async () => { calls++; await hold; return []; }, () => { errors++; });
  worker.tick(); worker.tick(); await Promise.resolve();
  assert.equal(calls, 1);
  let drained = false; const stop = worker.stop().then(() => { drained = true; });
  await Promise.resolve(); assert.equal(drained, false);
  release(); await stop; assert.equal(drained, true); assert.equal(errors, 0);
  const failed = createInfoWorker(async () => { throw new Error('secret'); }, () => { errors++; });
  failed.tick(); await failed.stop(); assert.equal(errors, 1);
  failed.tick(); await failed.stop(); assert.equal(errors, 2);
});

test('#159 durable atomic BLS slots enforce 0/25/26, independent concurrent clients and next UTC day; storage errors fail closed', async () => {
  await mkdir('.bun-cache/info159', { recursive: true });
  const folder = await mkdtemp(path.resolve('.bun-cache/info159/quota-'));
  try {
    const outcomes = await Promise.all(Array.from({ length: 26 }, () => reserveBlsRequest(folder, now())));
    assert.equal(outcomes.filter(Boolean).length, 25); assert.equal(outcomes.filter(value => !value).length, 1);
    assert.equal(await reserveBlsRequest(folder, now()), false);
    assert.equal(await reserveBlsRequest(folder, new Date('2026-11-20T23:59:59.999Z')), false);
    assert.equal(await reserveBlsRequest(folder, new Date('2026-11-21T00:00:00Z')), true);
    const blocked = path.join(folder, 'file'); await writeFile(blocked, 'x');
    await assert.rejects(reserveBlsRequest(blocked, now()), /bls_quota_unavailable/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('#159 opt-in job executes at the exact 30-minute threshold, prevents overlapping calls and recovers after lock failure', async () => {
  assert.equal(loadInfoConfig({}), null); assert.equal(loadInfoConfig({ INFO_COLLECTORS_ENABLED: '0', SEC_USER_AGENT: '\nsecret' }), null);
  const config = loadInfoConfig({ INFO_COLLECTORS_ENABLED: '1' }); assert.ok(config); assert.equal(config.intervalMs, 1800000); assert.equal(config.userAgent, null);
  for (const raw of ['0', '59', '86401', 'secret', '1.5']) assert.throws(() => loadInfoConfig({ INFO_COLLECTORS_ENABLED: '1', INFO_COLLECTORS_INTERVAL_SECONDS: raw }), /INFO_COLLECTORS_INTERVAL_SECONDS/);
  for (const raw of ['60', '86400']) assert.ok(loadInfoConfig({ INFO_COLLECTORS_ENABLED: '1', INFO_COLLECTORS_INTERVAL_SECONDS: raw }));
  assert.throws(() => loadInfoConfig({ INFO_COLLECTORS_ENABLED: 'true' }), /INFO_COLLECTORS_ENABLED/);
  assert.throws(() => loadInfoConfig({ INFO_COLLECTORS_ENABLED: '1', SEC_USER_AGENT: 'bad\r\nsecret' }), /SEC_USER_AGENT/);
  let time = now().getTime(), calls = 0;
  const run = createInfoJob({ env: { INFO_COLLECTORS_ENABLED: '1' }, now: () => new Date(time),
    collectors: [{ name: 'test', collect: async () => { calls++; return empty(); } }], save, log: () => {}, lock: action => action() });
  await Promise.all([run(), run()]); assert.equal(calls, 1);
  time += 1799999; assert.deepEqual(await run(), []); time++; await run(); assert.equal(calls, 2);
  assert.deepEqual(await createInfoJob({ env: {}, lock: async () => assert.fail('disabled job locked') })(), []);
  let locks = 0;
  const retry = createInfoJob({ env: { INFO_COLLECTORS_ENABLED: '1' }, now: () => new Date(time), collectors: [], lock: async () => { if (++locks === 1) throw new Error('db'); } });
  await assert.rejects(retry(), /db/); time += 1800000; await retry(); assert.equal(locks, 2);
});
