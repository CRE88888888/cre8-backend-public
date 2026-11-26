import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { createAnthropicDrafter, createDraftStore, draftFacts, InfoDraftError, loadInfoDraftConfig, MAX_DRAFT_INPUT_BYTES,
  MAX_DRAFT_RESPONSE_BYTES, validateDraft } from '../src/info/drafter.js';
import type { DraftEvent } from '../src/info/drafter.js';
import { createDraftState, DRAFT_BACKOFF_MS, DRAFT_MAX_BACKOFF_MS } from '../src/info/draft-state.js';
import { createInfoDraftJob, DRAFT_POLL_MS } from '../src/info/draft-job.js';
import { createInfoBackgroundJob } from '../src/info/job.js';

const env = { INFO_DRAFT_ENABLED: '1', ANTHROPIC_API_KEY: 'mock-anthropic-credential' };
const config = loadInfoDraftConfig(env); assert.ok(config);
const event: DraftEvent = { id: '165', revision: '2026-11-20 00:00:00.123456+00', source: 'bls', source_ref: 'cpi:2026-10',
  title_en: 'CPI, seasonally adjusted, 2026-10', actual: '-0.0010', expected: null, unit: 'index_1982_1984_100', asset_symbols: [],
  payload: { referencePeriod: '2026-10', timeBasis: 'reference_period_end', releaseDateAvailable: false } };
const title = '美國消費者物價指數（季節調整）；實際：-0.0010；預期查不到';
const response = (text: unknown = title, stop = 'end_turn') => new Response(JSON.stringify({ stop_reason: stop,
  content: [{ type: 'text', text: JSON.stringify({ title_zh: text }) }] }));
const lock = (action: () => Promise<void>) => action();
async function folder(action: (directory: string) => Promise<void>) {
  await mkdir('.bun-cache/info165', { recursive: true });
  const directory = await mkdtemp(path.resolve('.bun-cache/info165/draft-'));
  try { await action(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('#165 draft config defaults off, missing/blank key disables; enabled defaults and explicit model are bounded', () => {
  for (const values of [{}, { ...env, INFO_DRAFT_ENABLED: '0' }, { INFO_DRAFT_ENABLED: '1' }, { ...env, ANTHROPIC_API_KEY: ' ' }]) {
    assert.equal(loadInfoDraftConfig(values), null);
  }
  assert.equal(config.model, 'claude-haiku-5-5'); assert.equal(config.batchSize, 10); assert.equal(config.dailyLimit, 100);
  assert.equal(config.stateDir, path.resolve('.info-collectors'));
  assert.equal(loadInfoDraftConfig({ ...env, INFO_DRAFT_MODEL: 'custom-model-1' })?.model, 'custom-model-1');
  for (const batchSize of ['1', '100']) assert.equal(loadInfoDraftConfig({ ...env, INFO_DRAFT_BATCH_SIZE: batchSize })?.batchSize, Number(batchSize));
  for (const dailyLimit of ['0', '10000']) assert.equal(loadInfoDraftConfig({ ...env, INFO_DRAFT_DAILY_LIMIT: dailyLimit })?.dailyLimit, Number(dailyLimit));
  for (const [name, values] of Object.entries({ INFO_DRAFT_BATCH_SIZE: ['0', '101', '-1', '1.5', '1e2', 'sensitive-value'],
    INFO_DRAFT_DAILY_LIMIT: ['-1', '10001', 'Infinity'], INFO_DRAFT_ENABLED: ['true'], INFO_DRAFT_MODEL: ['invalid/name'],
    ANTHROPIC_API_KEY: ['sensitive-value\r\nheader'] })) {
    for (const value of values) assert.throws(() => loadInfoDraftConfig({ ...env, [name]: value }), error =>
      error instanceof Error && error.message.includes(name) && !error.message.includes('sensitive-value'));
  }
});

test('#165 request uses Messages API with fixed endpoint, no redirects/tools, explicit model and only public event facts', async () => {
  let calls = 0;
  const input = { ...event, payload: { ...event.payload, description: 'Source description', authorization: 'private-header',
    token: 'private-token', footnotes: [{ code: 'P', text: 'Preliminary', secret: 'private-nested' }] } };
  const actual = await createAnthropicDrafter(config, async (url, init) => {
    calls++; assert.equal(url, 'https://api.anthropic.com/v1/messages'); assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
    assert.ok(init.signal); assert.equal(new Headers(init.headers).get('x-api-key'), env.ANTHROPIC_API_KEY);
    const raw = String(init.body); assert.doesNotMatch(raw, /mock-anthropic-credential|private-header|private-token|private-nested|source_ref|revision/);
    const request: unknown = JSON.parse(raw); assert.ok(typeof request === 'object' && request !== null);
    assert.equal(Reflect.get(request, 'model'), config.model); assert.equal(Reflect.get(request, 'max_tokens'), 1024);
    assert.equal(Reflect.get(request, 'tools'), undefined);
    assert.match(String(Reflect.get(request, 'system')), /台灣用語/); assert.match(String(Reflect.get(request, 'system')), /預期查不到/);
    return response();
  })(input);
  assert.equal(calls, 1); assert.equal(actual, title);
  assert.deepEqual(draftFacts(input).payload.footnotes, [{ code: 'P', text: 'Preliminary' }]);
});

test('#165 draft accepts source zero, exact decimal/sign, explicit expected and the 500-character boundary', () => {
  const input = { ...event, actual: '0', expected: '-1.2300' };
  assert.equal(validateDraft('消費者物價指數；實際：0；預期：-1.2300', input), '消費者物價指數；實際：0；預期：-1.2300');
  assert.equal(validateDraft(title, event), title);
  const bare = { ...event, actual: null };
  const suffix = '；預期查不到';
  assert.equal(validateDraft('中'.repeat(500 - suffix.length) + suffix, bare).length, 500);
  assert.throws(() => validateDraft('中'.repeat(501 - suffix.length) + suffix, bare), /invalid_draft_response/);
  for (const expected of [null, '', ' ']) assert.equal(validateDraft(title, { ...event, expected }), title);
});

test('#165 rejects invented/rounded numbers, substituted consensus, simplified text, advice, empty or multiline output', () => {
  for (const value of [null, 1, '', ' ', title.replace('-0.0010', '-0.001'), title + '（9.9）',
    title.replace('預期查不到', '預期：-0.0010'), title + '，預期：-0.0010', title + '，共識：-0.0010',
    '美国经济数据；实际：-0.0010；预期查不到', title + '，必漲', title + '，建議買入', title + '\n第二句',
    'CPI -0.0010', title + '<script>']) assert.throws(() => validateDraft(value, event), /invalid_draft_response/);
  assert.throws(() => validateDraft(title, { ...event, expected: '0' }), /invalid_draft_response/);
  assert.throws(() => validateDraft(title, { ...event, actual: null }), /invalid_draft_response/);
});

test('#165 actual and expected labels must contain the whole original value, not a numeric prefix', () => {
  const input = { ...event, actual: '0', expected: '0.1' };
  assert.throws(() => validateDraft('公司公告；實際：0.1；預期：0.1', input), /invalid_draft_response/);
  assert.throws(() => validateDraft('公司公告；實際：0；預期：0.1', { ...input, expected: '0', title_en: 'Source value 0.1' }), /invalid_draft_response/);
});

test('#165 neutral descriptions of a source-confirmed purchase are allowed without investment advice', () => {
  const input = { ...event, title_en: 'Strategy Acquires 250 BTC', actual: null, source: 'strategy', asset_symbols: ['MSTR', 'BTC'], payload: {} };
  const headline = 'Strategy 買入 250 BTC；預期查不到';
  assert.equal(validateDraft(headline, input), headline);
});

test('#165 malformed Messages envelopes, truncated responses and non-JSON/extra fields never become drafts', async () => {
  for (const raw of ['not json', '{}', 'null', JSON.stringify({ stop_reason: 'end_turn', content: [] }),
    JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'tool_use', text: '{}' }] }),
    JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: '```json\n{}\n```' }] }),
    JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ title_zh: title, status: 'published' }) }] }),
    JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ title_zh: title }) }, { type: 'text', text: 'more' }] })]) {
    await assert.rejects(createAnthropicDrafter(config, async () => new Response(raw))(event), /invalid_draft_response/);
  }
  for (const stop of ['max_tokens', 'tool_use', 'refusal']) await assert.rejects(createAnthropicDrafter(config, async () => response(title, stop))(event), /invalid_draft_response/);
  await assert.rejects(createAnthropicDrafter(config, async () => new Response(null))(event), /invalid_draft_response/);
});

test('#165 upstream response byte cap allows equality and rejects overflow; oversized/missing/key-bearing input never calls API', async () => {
  const raw = await response().text();
  for (const size of [MAX_DRAFT_RESPONSE_BYTES, MAX_DRAFT_RESPONSE_BYTES + 1]) {
    const call = createAnthropicDrafter(config, async () => new Response(raw + ' '.repeat(size - Buffer.byteLength(raw))));
    if (size === MAX_DRAFT_RESPONSE_BYTES) assert.equal(await call(event), title);
    else await assert.rejects(call(event), /invalid_draft_response/);
  }
  for (const input of [{ ...event, title_en: '' }, { ...event, title_en: 'x'.repeat(MAX_DRAFT_INPUT_BYTES) },
    { ...event, payload: { description: env.ANTHROPIC_API_KEY } }]) {
    await assert.rejects(createAnthropicDrafter(config, async () => assert.fail('invalid input sent'))(input), /invalid_draft_input/);
  }
  const output = `${title} ${env.ANTHROPIC_API_KEY}`;
  await assert.rejects(createAnthropicDrafter(config, async () => response(output))(event), /invalid_draft_response/);
});

test('#165 timeout/network/HTTP failures expose only fixed codes; 429 Retry-After handles seconds/date/invalid/upper bound', async () => {
  await assert.rejects(createAnthropicDrafter(config, async () => { throw new Error(env.ANTHROPIC_API_KEY); })(event), /draft_network_unavailable/);
  await assert.rejects(createAnthropicDrafter(config, async (_url, init) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new Error(env.ANTHROPIC_API_KEY)), { once: true });
  }), 5)(event), /draft_timeout/);
  for (const status of [400, 401, 500, 503]) {
    await assert.rejects(createAnthropicDrafter(config, async () => new Response(env.ANTHROPIC_API_KEY, { status }))(event), /draft_http_error/);
  }
  const clock = Date.parse('2026-11-20T00:00:00Z');
  for (const [retry, expected] of [['120', 120000], ['Fri, 20 Nov 2026 00:03:00 GMT', 180000], ['bad', 0], ['-1', 0], ['999999', 86400000]] as const) {
    await assert.rejects(createAnthropicDrafter(config, async () => new Response(env.ANTHROPIC_API_KEY,
      { status: 429, headers: { 'retry-after': retry } }), 15000, () => clock)(event), error =>
      error instanceof InfoDraftError && error.code === 'draft_rate_limited' && error.retryAfterMs === expected && !error.message.includes(env.ANTHROPIC_API_KEY));
  }
});

test('#165 durable daily attempt slots enforce 0/limit/limit+1 across concurrent instances, failures and UTC midnight', async () => {
  await folder(async directory => {
    const clock = new Date('2026-11-20T23:59:59.999Z');
    assert.equal(await createDraftState(directory).reserve(0, clock), false);
    const results = await Promise.all(Array.from({ length: 5 }, () => createDraftState(directory).reserve(3, clock)));
    assert.equal(results.filter(Boolean).length, 3); assert.equal(results.filter(value => !value).length, 2);
    assert.equal(await createDraftState(directory).reserve(3, clock), false);
    assert.equal(await createDraftState(directory).reserve(3, new Date('2026-11-21T00:00:00Z')), true);
    const file = path.join(directory, 'blocked'); await writeFile(file, 'x');
    await assert.rejects(createDraftState(file).reserve(1, clock));
  });
});

test('#165 retry state survives restarts, includes exact thresholds, caps exponential delay and fails closed on corruption', async () => {
  await folder(async directory => {
    const state = createDraftState(directory), identity = 'opaque-event'; let clock = 0;
    assert.equal(await state.ready(identity, clock), true);
    for (let attempt = 0; attempt < 10; attempt++) {
      const next = await state.begin(identity, clock);
      assert.equal(next - clock, Math.min(DRAFT_BACKOFF_MS * 2 ** attempt, DRAFT_MAX_BACKOFF_MS));
      assert.equal(await createDraftState(directory).ready(identity, next - 1), false);
      assert.equal(await createDraftState(directory).ready(identity, next), true); clock = next;
    }
    await state.cooldown(clock); await state.cooldown(clock - 1);
    assert.equal(await createDraftState(directory).cooldownUntil(), clock);
    await state.clear(identity); assert.equal(await state.ready(identity, 0), true);
    const file = path.join(directory, 'drafts', 'retry', createHash('sha256').update(identity).digest('hex'));
    for (const raw of ['broken', '{"attempts":-1,"nextAt":0}', '{"attempts":1,"nextAt":"0"}']) {
      await writeFile(file, raw); await assert.rejects(state.ready(identity, clock));
    }
  });
});

test('#165 disabled/keyless/zero-quota job does no DB, filesystem or network work', async () => {
  for (const values of [{}, { INFO_DRAFT_ENABLED: '1' }, { ...env, INFO_DRAFT_DAILY_LIMIT: '0' }]) {
    const run = createInfoDraftJob({ env: values, lock: async () => assert.fail('disabled lock'),
      draft: async () => assert.fail('disabled API'), store: { collected: async () => assert.fail('disabled DB'), save: async () => assert.fail('disabled save') } });
    assert.deepEqual(await run(), { attempted: 0, drafted: 0, conflicted: 0, deferred: 0, failed: 0, error: null });
  }
});

test('#165 missing or malformed DB fields fail before sending a paid request', async () => {
  for (const invalid of [{ id: 165 }, { revision: null }, { title_en: null }, { actual: undefined }, { expected: 0 },
    { unit: false }, { source: null }, { source_ref: null }, { asset_symbols: [1] }, { payload: [] }]) {
    const store = createDraftStore(async () => ({ rows: [{ ...event, ...invalid }] }));
    await assert.rejects(store.collected('0', 1), /invalid_draft_input/);
  }
});

test('#165 per-round API limit is enforced at the minimum and maximum batch sizes', async () => {
  for (const batchSize of [1, 100]) {
    await folder(async directory => {
      const rows = Array.from({ length: batchSize + 1 }, (_, i) => ({ ...event, id: String(i + 1) }));
      let calls = 0;
      const run = createInfoDraftJob({ env: { ...env, INFO_DRAFT_BATCH_SIZE: String(batchSize) }, lock,
        state: createDraftState(directory), log: () => {}, draft: async () => { calls++; return title; },
        store: { collected: async (after, limit) => rows.filter(row => BigInt(row.id) > BigInt(after)).slice(0, limit), save: async () => true } });
      const result = await run(); assert.equal(result.drafted, batchSize); assert.equal(calls, batchSize);
    });
  }
});

test('#165 job enforces per-round calls, paginates beyond cooling events and resumes exactly at the next poll', async () => {
  await folder(async directory => {
    let clock = 0, calls = 0; const saved = new Set<string>();
    const rows = Array.from({ length: 4 }, (_, i) => ({ ...event, id: String(i + 1) }));
    const state = createDraftState(directory);
    await state.begin(JSON.stringify(['1', event.source, event.source_ref]), clock);
    const run = createInfoDraftJob({ env: { ...env, INFO_DRAFT_BATCH_SIZE: '2' }, lock, state,
      now: () => new Date(clock), log: () => {}, draft: async () => { calls++; return title; }, store: {
        collected: async (after, limit) => rows.filter(row => BigInt(row.id) > BigInt(after) && !saved.has(row.id)).slice(0, limit),
        save: async row => { saved.add(row.id); return true; },
      } });
    const first = await run(); assert.equal(first.attempted, 2); assert.equal(first.drafted, 2); assert.equal(first.deferred, 1);
    assert.deepEqual([...saved], ['2', '3']); assert.equal(calls, 2);
    clock = DRAFT_POLL_MS - 1; assert.equal((await run()).attempted, 0); clock++;
    assert.equal((await run()).drafted, 2); assert.equal(calls, 4);
    assert.equal((await readFile(path.join(directory, 'drafts', 'calls', '1970-01-01', '4'))).byteLength, 0);
  });
});

test('#165 API/DB failure preserves retry and daily attempts, other events finish, log excludes keys and exceptions', async () => {
  for (const failure of [new InfoDraftError('invalid_draft_response'), new InfoDraftError('draft_timeout'), new Error(env.ANTHROPIC_API_KEY)]) {
    await folder(async directory => {
      let clock = 0, calls = 0; const saved = new Set<string>(), logs: unknown[] = [];
      const rows = [event, { ...event, id: '166' }];
      const store = { collected: async (after: string) => rows.filter(row => BigInt(row.id) > BigInt(after) && !saved.has(row.id)),
        save: async (row: DraftEvent) => { if (failure instanceof Error && !(failure instanceof InfoDraftError) && row.id === event.id) throw failure;
          saved.add(row.id); return true; } };
      const make = () => createInfoDraftJob({ env: { ...env, INFO_DRAFT_DAILY_LIMIT: '3' }, lock, store,
        state: createDraftState(directory), now: () => new Date(clock), log: value => logs.push(value), draft: async row => {
          calls++; if (row.id === event.id && failure instanceof InfoDraftError) throw failure; return title;
        } });
      const first = await make()(); assert.equal(first.failed, 1); assert.equal(first.drafted, 1);
      assert.deepEqual([...saved], ['166']); assert.equal((await make()()).attempted, 0);
      clock = DRAFT_BACKOFF_MS; assert.equal((await make()()).attempted, 1);
      clock += DRAFT_MAX_BACKOFF_MS; assert.equal((await make()()).attempted, 0); assert.equal(calls, 3);
      assert.doesNotMatch(JSON.stringify(logs), /mock-anthropic-credential/);
    });
  }
});

test('#165 429 stops the round and persists shared cooldown across restarts at Retry-After equality', async () => {
  await folder(async directory => {
    let clock = 0, calls = 0;
    const make = () => createInfoDraftJob({ env, lock, now: () => new Date(clock), state: createDraftState(directory), log: () => {},
      store: { collected: async () => [event, { ...event, id: '166' }], save: async () => assert.fail('429 saved') },
      draft: async () => { calls++; throw new InfoDraftError('draft_rate_limited', 120000); } });
    assert.equal((await make()()).attempted, 1); clock = 119999; assert.equal((await make()()).attempted, 0);
    clock++; assert.equal((await make()()).attempted, 1); assert.equal(calls, 2);
  });
});

test('#165 overlapping calls do not duplicate API work; source/review conflicts are counted without saving again', async () => {
  await folder(async directory => {
    let release = () => {}, calls = 0, saved = 0;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const run = createInfoDraftJob({ env, lock, state: createDraftState(directory), log: () => {},
      store: { collected: async after => after === '0' ? [event] : [], save: async () => { saved++; return false; } },
      draft: async () => { calls++; await hold; return title; } });
    const first = run(); assert.equal((await run()).attempted, 0); release();
    assert.equal((await first).conflicted, 1); assert.equal(calls, 1); assert.equal(saved, 1);
  });
});

test('#165 lock/read/state failures fail closed and report static errors', async () => {
  await folder(async directory => {
    for (const stage of ['lock', 'read', 'state']) {
      const file = path.join(directory, 'file'); await writeFile(file, 'x');
      const run = createInfoDraftJob({ env, state: createDraftState(stage === 'state' ? file : directory),
        lock: async action => { if (stage === 'lock') throw new Error(env.ANTHROPIC_API_KEY); await action(); }, log: () => {},
        store: { collected: async () => { throw new Error(env.ANTHROPIC_API_KEY); }, save: async () => assert.fail('failure saved') },
        draft: async () => assert.fail('failure sent') });
      assert.equal((await run()).error, 'draft_dependency_unavailable');
    }
  });
});

test('#165 background collection and drafting run independently through either failure', async () => {
  for (const fail of ['collect', 'draft', 'none']) {
    const seen: string[] = []; let errors = 0;
    const run = createInfoBackgroundJob(async () => { seen.push('collect'); if (fail === 'collect') throw new Error('private'); },
      async () => { seen.push('draft'); if (fail === 'draft') throw new Error('private'); }, () => { errors++; });
    assert.equal(await run(), fail === 'none'); assert.deepEqual(seen, ['collect', 'draft']); assert.equal(errors, fail === 'none' ? 0 : 1);
  }
});
