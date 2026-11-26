import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { zeroHash } from 'viem';
import { getPool, closePool, migrate } from '../src/db.js';
import { createServer } from '../src/server.js';
import { createUserMedia } from '../src/user-media.js';
import { loadRateLimitConfig } from '../src/config.js';
import { MemoryRateLimitStore, RequestRateLimiter } from '../src/ratelimit.js';
import { UnauthorizedError } from '../src/errors.js';
import { JPEG_3X2, WEBP_LOSSLESS_3X2, WEBP_LOSSY_3X2 } from './fixtures/user-media.js';

after(closePool);
const wallet = () => `0x${randomBytes(20).toString('hex')}`;

/** Everything runs in one rolled-back transaction; savepoints stand in for the service's own transactions. */
async function withDb(work: (client: PoolClient, media: ReturnType<typeof createUserMedia>) => Promise<void>) {
  await migrate();
  const client = await getPool().connect();
  try {
    await client.query('begin');
    let n = 0;
    const media = createUserMedia({
      query: ((sql: string, params?: unknown[]) => client.query(sql, params)) as never,
      transaction: async (fn) => {
        const name = `sp${++n}`;
        await client.query(`savepoint ${name}`);
        try { const result = await fn(client); await client.query(`release savepoint ${name}`); return result; }
        catch (error) { await client.query(`rollback to savepoint ${name}`); throw error; }
      },
    });
    await work(client, media);
  } finally { await client.query('rollback'); client.release(); }
}

async function insertMix(client: PoolClient, owner: string): Promise<number> {
  const sid = (await client.query<{ id: string }>(`insert into strategies(provider,name,is_public,is_personal_mix) values($1,'media test',false,true) returning id`, [owner])).rows[0]?.id;
  assert.ok(sid);
  const id = (await client.query<{ id: string }>(`insert into mixes(owner,name,chain_id,account,initial_strategy_id,account_salt)
    values($1,'cover test',97,$2,$3,$4) returning id`, [owner, wallet(), sid, zeroHash])).rows[0]?.id;
  assert.ok(id);
  return Number(id);
}
const count = async (client: PoolClient, owner: string) =>
  Number((await client.query<{ n: string }>('select count(*)::text as n from user_images where owner=$1', [owner])).rows[0]?.n);

test('#192 profile: defaults, name set/clear, avatar replace deletes the old image, delete clears it', async () => {
  await withDb(async (client, media) => {
    const owner = wallet();
    assert.deepEqual(await media.profile(owner.toUpperCase().replace('0X', '0x')), { address: owner, displayName: null, avatarUrl: null });
    assert.equal((await media.updateProfile(owner, { displayName: '  Ada  ' })).displayName, 'Ada');
    await assert.rejects(media.updateProfile(owner, { displayName: '字'.repeat(41) }), /名稱/);
    await assert.rejects(media.updateProfile(owner, { displayName: 'x', avatar: 'y' }), /displayName/);
    const first = await media.setAvatar(owner, { contentType: 'image/webp', dataBase64: WEBP_LOSSY_3X2 });
    assert.match(first.avatarUrl ?? '', /^\/images\/[0-9a-f-]{36}$/);
    assert.equal(first.displayName, 'Ada');
    const second = await media.setAvatar(owner, { contentType: 'image/jpeg', dataBase64: JPEG_3X2 });
    assert.notEqual(second.avatarUrl, first.avatarUrl);
    assert.equal(await count(client, owner), 1);
    const old = (first.avatarUrl ?? '').split('/')[2] ?? '';
    await assert.rejects(media.image(old), /找不到圖片/);
    const current = await media.image((second.avatarUrl ?? '').split('/')[2] ?? '');
    assert.equal(current.contentType, 'image/jpeg'); assert.deepEqual(current.bytes, Buffer.from(JPEG_3X2, 'base64'));
    // A rejected upload leaves the existing avatar untouched.
    await assert.rejects(media.setAvatar(owner, { contentType: 'image/webp', dataBase64: JPEG_3X2 }), /不一致/);
    assert.equal((await media.profile(owner)).avatarUrl, second.avatarUrl);
    assert.deepEqual(await media.deleteAvatar(owner), { address: owner, displayName: 'Ada', avatarUrl: null });
    assert.equal(await count(client, owner), 0);
    assert.equal((await media.updateProfile(owner, { displayName: null })).displayName, null);
    // Deleting with no profile row is a harmless no-op.
    const fresh = wallet();
    assert.deepEqual(await media.deleteAvatar(fresh), { address: fresh, displayName: null, avatarUrl: null });
  });
});

test('#192 mix cover: owner only, replace/clear deletes images, deleted mixes and other owners get 404', async () => {
  await withDb(async (client, media) => {
    const owner = wallet(), other = wallet();
    const mixId = await insertMix(client, owner);
    const set = await media.setMixCover(owner, mixId, { contentType: 'image/webp', dataBase64: WEBP_LOSSLESS_3X2 });
    assert.match(set.coverUrl ?? '', /^\/images\//);
    await assert.rejects(media.setMixCover(other, mixId, { contentType: 'image/webp', dataBase64: WEBP_LOSSY_3X2 }), /找不到這個組合/);
    await assert.rejects(media.setMixCover(other, mixId, null), /找不到這個組合/);
    assert.equal(await count(client, other), 0);
    const replaced = await media.setMixCover(owner, mixId, { contentType: 'image/webp', dataBase64: WEBP_LOSSY_3X2 });
    assert.notEqual(replaced.coverUrl, set.coverUrl); assert.equal(await count(client, owner), 1);
    const stored = (await client.query<{ cover_image_id: string }>('select cover_image_id::text from mixes where id=$1', [mixId])).rows[0];
    assert.equal(`/images/${stored?.cover_image_id}`, replaced.coverUrl);
    assert.deepEqual(await media.setMixCover(owner, mixId, null), { mixId, coverUrl: null });
    assert.equal(await count(client, owner), 0);
    await client.query('update mixes set deleted_at=now() where id=$1', [mixId]);
    await assert.rejects(media.setMixCover(owner, mixId, { contentType: 'image/webp', dataBase64: WEBP_LOSSY_3X2 }), /找不到這個組合/);
    await assert.rejects(media.setMixCover(owner, 999_999_999, null), /找不到這個組合/);
    for (const id of ['not-a-uuid', '11111111-1111-4111-8111-111111111111', '../etc']) await assert.rejects(media.image(id), /找不到圖片/);
  });
});

test('#192 HTTP: profile/avatar/cover routes, public immutable image with ETag/304, CORS PUT/DELETE', async () => {
  await withDb(async (client, media) => {
    const owner = wallet();
    const mixId = await insertMix(client, owner);
    const server = createServer({
      userMedia: media,
      rateLimiter: new RequestRateLimiter(loadRateLimitConfig({}), new MemoryRateLimitStore()),
      auth: { authenticate: async (header) => { if (header !== 'Bearer ok') throw new UnauthorizedError('login required'); return owner; },
        issueNonce: () => { throw new Error('unused'); }, login: async () => { throw new Error('unused'); }, logout: async () => {} },
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const auth = { authorization: 'Bearer ok', 'content-type': 'application/json' };
    try {
      assert.equal((await fetch(`${base}/me/profile`)).status, 401);
      const preflight = await fetch(`${base}/me/profile/avatar`, { method: 'OPTIONS', headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'PUT' } });
      assert.equal(preflight.status, 204);
      assert.match(preflight.headers.get('access-control-allow-methods') ?? '', /PUT, DELETE/);
      assert.deepEqual(await (await fetch(`${base}/me/profile`, { headers: auth })).json(), { address: owner, displayName: null, avatarUrl: null });
      const patched = await fetch(`${base}/me/profile`, { method: 'PATCH', headers: auth, body: JSON.stringify({ displayName: 'Mia' }) });
      assert.equal(patched.status, 200);
      assert.equal((await fetch(`${base}/me/profile`, { method: 'PATCH', headers: auth, body: JSON.stringify({ displayName: '' }) })).status, 400);
      assert.equal((await fetch(`${base}/me/profile`, { method: 'POST', headers: auth, body: '{}' })).status, 405);
      const put = await fetch(`${base}/me/profile/avatar`, { method: 'PUT', headers: auth, body: JSON.stringify({ contentType: 'image/webp', dataBase64: WEBP_LOSSY_3X2 }) });
      assert.equal(put.status, 200);
      const profile: unknown = await put.json();
      assert.ok(profile && typeof profile === 'object' && 'avatarUrl' in profile && typeof profile.avatarUrl === 'string');
      const image = await fetch(base + profile.avatarUrl);
      assert.equal(image.status, 200);
      assert.equal(image.headers.get('content-type'), 'image/webp');
      assert.equal(image.headers.get('cache-control'), 'public, max-age=31536000, immutable');
      assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
      assert.deepEqual(Buffer.from(await image.arrayBuffer()), Buffer.from(WEBP_LOSSY_3X2, 'base64'));
      const etag = image.headers.get('etag'); assert.match(etag ?? '', /^"[0-9a-f]{64}"$/);
      const cached = await fetch(base + profile.avatarUrl, { headers: { 'if-none-match': etag ?? '' } });
      assert.equal(cached.status, 304);
      assert.equal((await fetch(base + profile.avatarUrl, { method: 'POST' })).status, 405);
      assert.equal((await fetch(`${base}/images/11111111-1111-4111-8111-111111111111`)).status, 404);
      const badAvatar = await fetch(`${base}/me/profile/avatar`, { method: 'PUT', headers: auth, body: JSON.stringify({ contentType: 'image/png', dataBase64: 'AAAA' }) });
      assert.equal(badAvatar.status, 400);
      assert.match(await badAvatar.text(), /INVALID_IMAGE/);
      const cover = await fetch(`${base}/me/mixes/${mixId}/cover`, { method: 'PUT', headers: auth, body: JSON.stringify({ contentType: 'image/jpeg', dataBase64: JPEG_3X2 }) });
      assert.equal(cover.status, 200);
      const coverBody: unknown = await cover.json();
      assert.ok(coverBody && typeof coverBody === 'object' && 'coverUrl' in coverBody && typeof coverBody.coverUrl === 'string');
      assert.equal((await fetch(base + coverBody.coverUrl)).headers.get('content-type'), 'image/jpeg');
      assert.equal((await fetch(`${base}/me/mixes/${mixId}/cover`, { method: 'GET', headers: auth })).status, 405);
      assert.equal((await fetch(`${base}/me/mixes/abc/cover`, { method: 'DELETE', headers: auth })).status, 400);
      assert.deepEqual(await (await fetch(`${base}/me/mixes/${mixId}/cover`, { method: 'DELETE', headers: auth })).json(), { mixId, coverUrl: null });
      const deleted = await fetch(`${base}/me/profile/avatar`, { method: 'DELETE', headers: auth });
      assert.deepEqual(await deleted.json(), { address: owner, displayName: 'Mia', avatarUrl: null });
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
