import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeImageUpload, imageUrl, MAX_IMAGE_BYTES, parseDisplayName, parseImage } from '../src/user-media.js';
import { JPEG_3X2, WEBP_LOSSLESS_3X2, WEBP_LOSSY_3X2 } from './fixtures/user-media.js';

const b64 = (value: string) => Buffer.from(value, 'base64');

function vp8x(width: number, height: number): Buffer {
  const body = Buffer.alloc(18);
  body.write('VP8X', 0, 'latin1'); body.writeUInt32LE(10, 4); body[8] = 0x10;
  body.writeUIntLE(width - 1, 12, 3); body.writeUIntLE(height - 1, 15, 3);
  const header = Buffer.alloc(12); header.write('RIFF', 0, 'latin1'); header.writeUInt32LE(body.length + 4, 4); header.write('WEBP', 8, 'latin1');
  return Buffer.concat([header, body]);
}
function jpegWithSof(width: number, height: number): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc2, 0x00, 0x0b, 0x08,
    height >> 8, height & 0xff, width >> 8, width & 0xff, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9]);
}

test('#192 real JPEG and WebP (lossy, lossless, extended) parse type and header dimensions', () => {
  assert.deepEqual(parseImage(b64(JPEG_3X2)), { contentType: 'image/jpeg', width: 3, height: 2 });
  assert.deepEqual(parseImage(b64(WEBP_LOSSY_3X2)), { contentType: 'image/webp', width: 3, height: 2 });
  assert.deepEqual(parseImage(b64(WEBP_LOSSLESS_3X2)), { contentType: 'image/webp', width: 3, height: 2 });
  assert.deepEqual(parseImage(vp8x(512, 300)), { contentType: 'image/webp', width: 512, height: 300 });
  assert.deepEqual(parseImage(jpegWithSof(2048, 1)), { contentType: 'image/jpeg', width: 2048, height: 1 });
});

test('#192 images: exact size/side limits, wrong containers and forged headers are rejected', () => {
  assert.throws(() => parseImage(vp8x(2049, 10)), /WebP 或 JPEG/);
  assert.throws(() => parseImage(jpegWithSof(10, 2049)), /WebP 或 JPEG/);
  assert.throws(() => parseImage(jpegWithSof(0, 10)), /WebP 或 JPEG/);
  assert.deepEqual(parseImage(vp8x(2048, 2048)), { contentType: 'image/webp', width: 2048, height: 2048 });
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const gif = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1');
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
  for (const bad of [png, gif, svg, Buffer.alloc(0)]) assert.throws(() => parseImage(bad), /WebP 或 JPEG/);
  // RIFF size must match the actual length (truncated or padded uploads).
  const lossy = b64(WEBP_LOSSY_3X2);
  assert.throws(() => parseImage(lossy.subarray(0, lossy.length - 1)));
  assert.throws(() => parseImage(Buffer.concat([lossy, Buffer.from([0])])));
  // A RIFF that is not WEBP (e.g. WAV), a VP8 without start code, a VP8L without signature.
  const wav = Buffer.from(lossy); wav.write('WAVE', 8, 'latin1'); assert.throws(() => parseImage(wav));
  const noStart = Buffer.from(lossy); noStart[23] = 0; assert.throws(() => parseImage(noStart));
  const lossless = Buffer.from(b64(WEBP_LOSSLESS_3X2)); lossless[20] = 0; assert.throws(() => parseImage(lossless));
  // JPEG with no frame header before scan/end, or a segment length past the end.
  assert.throws(() => parseImage(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9])));
  assert.throws(() => parseImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x7f, 0xff, 0x00])));
  // Over the byte cap, even with a valid header.
  const big = Buffer.concat([jpegWithSof(10, 10), Buffer.alloc(MAX_IMAGE_BYTES)]);
  assert.throws(() => parseImage(big), /WebP 或 JPEG/);
});

test('#192 uploads: exact keys, declared type must match content, strict base64 and the 256 KiB boundary', () => {
  const ok = decodeImageUpload({ contentType: 'image/webp', dataBase64: WEBP_LOSSY_3X2 });
  assert.equal(ok.contentType, 'image/webp'); assert.equal(ok.width, 3); assert.match(ok.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(ok.bytes, b64(WEBP_LOSSY_3X2));
  assert.throws(() => decodeImageUpload({ contentType: 'image/jpeg', dataBase64: WEBP_LOSSY_3X2 }), /不一致/);
  for (const bad of [null, [], 'x', {}, { contentType: 'image/webp' }, { contentType: 'image/png', dataBase64: WEBP_LOSSY_3X2 },
    { contentType: 'image/webp', dataBase64: WEBP_LOSSY_3X2, extra: 1 }, { contentType: 'image/webp', dataBase64: '' },
    { contentType: 'image/webp', dataBase64: 'not base64!' }, { contentType: 'image/webp', dataBase64: WEBP_LOSSY_3X2.slice(0, -1) },
    { contentType: 'image/webp', dataBase64: 12 }]) {
    assert.throws(() => decodeImageUpload(bad), /圖片|WebP/);
  }
  // Exactly 256 KiB is accepted; one more byte is rejected (padding a real JPEG after EOI).
  const exact = Buffer.concat([jpegWithSof(8, 8), Buffer.alloc(MAX_IMAGE_BYTES - jpegWithSof(8, 8).length)]);
  assert.equal(decodeImageUpload({ contentType: 'image/jpeg', dataBase64: exact.toString('base64') }).bytes.length, MAX_IMAGE_BYTES);
  const over = Buffer.concat([exact, Buffer.from([0])]);
  assert.throws(() => decodeImageUpload({ contentType: 'image/jpeg', dataBase64: over.toString('base64') }));
});

test('#192 display names: trimmed, NFC, 1-40 code points, null clears, controls and non-strings rejected', () => {
  assert.equal(parseDisplayName('  Alice  '), 'Alice');
  assert.equal(parseDisplayName('字'.repeat(40)), '字'.repeat(40));
  assert.equal(parseDisplayName('😀'.repeat(40)), '😀'.repeat(40));
  assert.equal(parseDisplayName('é'), 'é');
  assert.equal(parseDisplayName(null), null);
  for (const bad of ['', '   ', '字'.repeat(41), '😀'.repeat(41), 'a\nb', 'a\u0000', 'a\u007f', 12, undefined, {}]) {
    assert.throws(() => parseDisplayName(bad), /名稱/);
  }
  assert.equal(imageUrl(null), null);
  assert.equal(imageUrl('11111111-1111-4111-8111-111111111111'), '/images/11111111-1111-4111-8111-111111111111');
});
