import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { CompactSign, SignJWT } from 'jose';
import type { JWTPayload, JWTHeaderParameters } from 'jose';
import type { SessionRepository } from '../../src/auth.js';
import type { PrivyUserRepository } from '../../src/privy.js';

/** Only ephemeral local P-256 keys: no Privy service, credentials, or network calls. */
export function privyFixture() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const config = { appId: 'local-privy-test', verificationKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
  const userId = 'did:privy:' + randomUUID();
  const now = Date.now();
  const owner = '0x1234567890abcdef1234567890abcdef12345678';
  const other = '0xabcdef1234567890abcdef1234567890abcdef12';
  const wallet = { type: 'wallet', chain_type: 'ethereum', address: owner, wallet_client_type: 'privy' };
  const claims = { sub: userId, iss: 'privy.io', aud: config.appId, iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + 3600, linked_accounts: JSON.stringify([wallet]) };
  return {
    config, userId, now, owner, other, wallet,
    sign: (overrides: JWTPayload = {}, header: JWTHeaderParameters = { alg: 'ES256' }) =>
      new SignJWT({ ...claims, ...overrides }).setProtectedHeader(header).sign(privateKey),
    /** Build deliberately invalid wire claims without lying to the JWT payload type. */
    signRaw: (overrides: Record<string, unknown>) =>
      new CompactSign(new TextEncoder().encode(JSON.stringify({ ...claims, ...overrides })))
        .setProtectedHeader({ alg: 'ES256' }).sign(privateKey),
  };
}

export function privyMemory() {
  const mappings = new Map<string, string>();
  const rows = new Map<string, { wallet: string; expiresAt: Date }>();
  const users: PrivyUserRepository = {
    find: async (id) => mappings.get(id) ?? null,
    create: async (id, owner) => {
      if (!mappings.has(id)) mappings.set(id, owner);
      return mappings.get(id) ?? owner;
    },
  };
  const sessions: SessionRepository = {
    save: async (hash, wallet, expiresAt) => { rows.set(hash, { wallet, expiresAt }); },
    find: async (hash) => rows.get(hash) ?? null,
    remove: async (hash) => { rows.delete(hash); },
    prune: async (now) => { for (const [hash, row] of rows) if (row.expiresAt <= now) rows.delete(hash); },
  };
  return { mappings, rows, users, sessions };
}
