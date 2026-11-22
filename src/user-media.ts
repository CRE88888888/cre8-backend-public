import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { query as dbQuery, withTransaction } from './db.js';
import { AppError, ValidationError } from './errors.js';

/**
 * Profile name/avatar and My mix cover images (backend#192, db 0059).
 * Images are small, client-resized WebP/JPEG stored in Postgres and served by an unguessable id.
 * The server never decodes pixels: it verifies the container magic bytes and the header dimensions only.
 */
export const MAX_IMAGE_BYTES = 262_144;
export const MAX_IMAGE_SIDE = 2048;
export const MAX_DISPLAY_NAME = 40;
export type ImageType = 'image/webp' | 'image/jpeg';
export type ImagePurpose = 'avatar' | 'mix_cover';
export type ParsedImage = { contentType: ImageType; width: number; height: number };
export type StoredImage = { contentType: ImageType; bytes: Buffer; sha256: string };
export type Profile = { address: string; displayName: string | null; avatarUrl: string | null };

const invalidImage = (message = '請上傳 WebP 或 JPEG 圖片，大小不超過 256 KB、邊長不超過 2048 像素。') =>
  new ValidationError('INVALID_IMAGE', message);

export const imageUrl = (id: string | null | undefined): string | null => id ? `/images/${id}` : null;

function jpegSize(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw invalidImage();
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) throw invalidImage();
    let marker = bytes[offset + 1] ?? 0;
    // Fill bytes (0xFF padding) may precede a marker.
    while (marker === 0xff && offset + 2 < bytes.length) { offset++; marker = bytes[offset + 1] ?? 0; }
    if (marker === 0xd9 || marker === 0xda) break; // EOI / start of scan before any frame header
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) throw invalidImage();
    const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (sof) {
      if (length < 7) throw invalidImage();
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  throw invalidImage();
}

function webpSize(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 30 || bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WEBP') throw invalidImage();
  if (bytes.readUInt32LE(4) + 8 !== bytes.length) throw invalidImage();
  const chunk = bytes.toString('latin1', 12, 16);
  if (chunk === 'VP8 ') {
    // Frame tag (3 bytes) then the 0x9d 0x01 0x2a start code, then 14-bit width/height.
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) throw invalidImage();
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    if (bytes[20] !== 0x2f) throw invalidImage();
    const bits = bytes.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    const width = (bytes[24] ?? 0) | ((bytes[25] ?? 0) << 8) | ((bytes[26] ?? 0) << 16);
    const height = (bytes[27] ?? 0) | ((bytes[28] ?? 0) << 8) | ((bytes[29] ?? 0) << 16);
    return { width: width + 1, height: height + 1 };
  }
  throw invalidImage();
}

/** Detects the real type from content; the declared type must agree. */
export function parseImage(bytes: Buffer): ParsedImage {
  if (bytes.length < 1 || bytes.length > MAX_IMAGE_BYTES) throw invalidImage();
  const contentType: ImageType | null = bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg'
    : bytes.toString('latin1', 0, 4) === 'RIFF' ? 'image/webp' : null;
  if (contentType === null) throw invalidImage();
  const { width, height } = contentType === 'image/jpeg' ? jpegSize(bytes) : webpSize(bytes);
  if (width < 1 || height < 1 || width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE) throw invalidImage();
  return { contentType, width, height };
}

/** Body `{contentType, dataBase64}`: JSON keeps the website proxy and CORS simple. */
export function decodeImageUpload(input: unknown): StoredImage & ParsedImage {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw invalidImage();
  const keys = Object.keys(input);
  if (keys.length !== 2 || !keys.includes('contentType') || !keys.includes('dataBase64')) throw invalidImage();
  const { contentType, dataBase64 } = input as { contentType: unknown; dataBase64: unknown };
  if (contentType !== 'image/webp' && contentType !== 'image/jpeg') throw invalidImage();
  if (typeof dataBase64 !== 'string' || dataBase64.length === 0 || dataBase64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(dataBase64)) throw invalidImage();
  const bytes = Buffer.from(dataBase64, 'base64');
  const parsed = parseImage(bytes);
  if (parsed.contentType !== contentType) throw invalidImage('圖片格式與宣告的類型不一致，請重新選擇圖片。');
  return { ...parsed, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** `null` clears the name. Counts Unicode code points after NFC and trimming. */
export function parseDisplayName(input: unknown): string | null {
  if (input === null) return null;
  if (typeof input !== 'string') throw new ValidationError('INVALID_DISPLAY_NAME', '名稱須為文字。');
  const name = input.normalize('NFC').trim();
  if ([...name].length < 1 || [...name].length > MAX_DISPLAY_NAME || /[\u0000-\u001f\u007f-\u009f]/.test(name)) {
    throw new ValidationError('INVALID_DISPLAY_NAME', `名稱須為 1 至 ${MAX_DISPLAY_NAME} 個字，不能只有空白。`);
  }
  return name;
}

type Query = typeof dbQuery;
export type UserMediaDeps = { query: Query; transaction: <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T> };
const owned = (owner: string) => owner.toLowerCase();
const unavailable = () => new AppError(503, 'PROFILE_UNAVAILABLE', '目前無法讀取個人資料，請稍後再試。');

async function insertImage(client: PoolClient, owner: string, purpose: ImagePurpose, image: StoredImage & ParsedImage): Promise<string> {
  const row = (await client.query<{ id: string }>(`insert into user_images(owner,purpose,content_type,bytes,sha256,width,height)
    values($1,$2,$3,$4,$5,$6,$7) returning id::text`, [owner, purpose, image.contentType, image.bytes, image.sha256, image.width, image.height])).rows[0];
  if (!row) throw unavailable();
  return row.id;
}

/** Drop a replaced image once nothing references it (no orphan rows accumulate). */
async function dropIfUnreferenced(client: PoolClient, id: string | null): Promise<void> {
  if (!id) return;
  await client.query(`delete from user_images i where i.id=$1
    and not exists(select 1 from user_profiles p where p.avatar_image_id=i.id)
    and not exists(select 1 from mixes m where m.cover_image_id=i.id)`, [id]);
}

export function createUserMedia(overrides: Partial<UserMediaDeps> = {}) {
  const deps: UserMediaDeps = { query: dbQuery, transaction: withTransaction, ...overrides };
  async function profile(owner: string): Promise<Profile> {
    const row = (await deps.query<{ display_name: string | null; avatar_image_id: string | null }>(
      'select display_name,avatar_image_id::text from user_profiles where owner=$1', [owned(owner)])).rows[0];
    return { address: owned(owner), displayName: row?.display_name ?? null, avatarUrl: imageUrl(row?.avatar_image_id) };
  }
  return {
    profile,
    async updateProfile(owner: string, input: unknown): Promise<Profile> {
      if (typeof input !== 'object' || input === null || Array.isArray(input) || Object.keys(input).length !== 1 || !('displayName' in input)) {
        throw new ValidationError('INVALID_PROFILE', '請只送出 displayName。');
      }
      const displayName = parseDisplayName(input.displayName);
      await deps.query(`insert into user_profiles(owner,display_name) values($1,$2)
        on conflict(owner) do update set display_name=excluded.display_name, updated_at=now()`, [owned(owner), displayName]);
      return profile(owner);
    },
    async setAvatar(owner: string, input: unknown): Promise<Profile> {
      const image = decodeImageUpload(input);
      await deps.transaction(async (client) => {
        const previous = (await client.query<{ avatar_image_id: string | null }>(
          'select avatar_image_id::text from user_profiles where owner=$1 for update', [owned(owner)])).rows[0]?.avatar_image_id ?? null;
        const id = await insertImage(client, owned(owner), 'avatar', image);
        await client.query(`insert into user_profiles(owner,avatar_image_id) values($1,$2)
          on conflict(owner) do update set avatar_image_id=excluded.avatar_image_id, updated_at=now()`, [owned(owner), id]);
        await dropIfUnreferenced(client, previous);
      });
      return profile(owner);
    },
    async deleteAvatar(owner: string): Promise<Profile> {
      await deps.transaction(async (client) => {
        const previous = (await client.query<{ avatar_image_id: string | null }>(
          'select avatar_image_id::text from user_profiles where owner=$1 for update', [owned(owner)])).rows[0]?.avatar_image_id ?? null;
        await client.query('update user_profiles set avatar_image_id=null, updated_at=now() where owner=$1', [owned(owner)]);
        await dropIfUnreferenced(client, previous);
      });
      return profile(owner);
    },
    /** Only the mix owner, and only a live (not deleted) mix. Other owners see 404, never another user's mix. */
    async setMixCover(owner: string, mixId: number, input: unknown | null): Promise<{ mixId: number; coverUrl: string | null }> {
      const image = input === null ? null : decodeImageUpload(input);
      const coverId = await deps.transaction(async (client) => {
        const mix = (await client.query<{ cover_image_id: string | null }>(
          'select cover_image_id::text from mixes where id=$1 and owner=$2 and deleted_at is null for update', [mixId, owned(owner)])).rows[0];
        if (!mix) throw new AppError(404, 'MIX_NOT_FOUND', '找不到這個組合。');
        const id = image ? await insertImage(client, owned(owner), 'mix_cover', image) : null;
        await client.query('update mixes set cover_image_id=$2 where id=$1', [mixId, id]);
        await dropIfUnreferenced(client, mix.cover_image_id);
        return id;
      });
      return { mixId, coverUrl: imageUrl(coverId) };
    },
    async image(id: string): Promise<{ contentType: ImageType; bytes: Buffer; etag: string }> {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new AppError(404, 'IMAGE_NOT_FOUND', '找不到圖片。');
      const row = (await deps.query<{ content_type: ImageType; bytes: Buffer; sha256: string }>(
        'select content_type,bytes,sha256 from user_images where id=$1', [id])).rows[0];
      if (!row) throw new AppError(404, 'IMAGE_NOT_FOUND', '找不到圖片。');
      return { contentType: row.content_type, bytes: row.bytes, etag: `"${row.sha256}"` };
    },
  };
}
