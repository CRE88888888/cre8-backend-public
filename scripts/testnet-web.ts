import { createServer, request } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

/** Railway overwrites X-Real-IP; XFF can contain additional edge hops. Verified with spoofed headers. */
export function gatewayClientIp(peer: string | undefined, realIp: string | string[] | undefined): string {
  const client = typeof realIp === 'string' ? realIp.trim() : undefined;
  return client && isIP(client) ? client : peer && isIP(peer) ? peer : 'unknown';
}

function headers(input: IncomingHttpHeaders): IncomingHttpHeaders {
  const blocked = new Set([...HOP, ...(typeof input.connection === 'string' ? input.connection.toLowerCase().split(',').map((s) => s.trim()) : [])]);
  return Object.fromEntries(Object.entries(input).filter(([name]) => !blocked.has(name)));
}

/**
 * backend#205: keep the API's explicit `public` cache header (images, public lists) on successful unauthenticated
 * requests; everything else — any Authorization, errors, private or missing headers — stays no-store.
 */
export function cacheControl(authorization: string | undefined, status: number | undefined, upstream: string | undefined): string {
  if (authorization !== undefined || status === undefined || status < 200 || status >= 300 || typeof upstream !== 'string') return 'no-store';
  const directives = upstream.toLowerCase().split(',').map(d => d.trim());
  return directives.includes('public') && !directives.some(d => d === 'private' || d === 'no-store') ? upstream : 'no-store';
}

export async function createTestnetWebsite(root: string, upstream: URL, timeoutMs = 30_000) {
  if (upstream.protocol !== 'http:' || upstream.username || upstream.password || upstream.pathname !== '/' || upstream.search || upstream.hash) throw new Error('invalid API origin');
  const base = await realpath(root);
  await stat(resolve(base, 'index.html'));
  return createServer(async (req, res) => {
    const fail = (status: number, code: string) => {
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ code }));
    };
    const raw = req.url ?? '/';
    if (!raw.startsWith('/') || raw.startsWith('//')) { fail(400, 'INVALID_PATH'); return; }
    if (raw === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ status: 'ok', chainId: 97, service: 'testnet-website' })); return;
    }
    if (raw === '/api' || raw.startsWith('/api/') || raw.startsWith('/api?')) {
      const path = raw.slice(4) || '/';
      // Do not resolve a URL from untrusted input (// could change the destination).
      const forwarded = headers(req.headers);
      delete forwarded.host;
      forwarded['x-forwarded-for'] = gatewayClientIp(req.socket.remoteAddress, req.headers['x-real-ip']);
      const proxy = request(upstream, { method: req.method, path: path.startsWith('?') ? '/' + path : path, headers: forwarded }, (response) => {
        res.writeHead(response.statusCode ?? 502, { ...headers(response.headers), 'cache-control': cacheControl(req.headers.authorization, response.statusCode, response.headers['cache-control']) });
        response.on('error', () => fail(502, 'API_UNAVAILABLE'));
        response.pipe(res);
      });
      const deadline = setTimeout(() => proxy.destroy(new Error('deadline')), timeoutMs);
      proxy.once('close', () => clearTimeout(deadline));
      proxy.once('error', () => fail(502, 'API_UNAVAILABLE'));
      req.once('aborted', () => proxy.destroy());
      res.once('close', () => { if (!res.writableFinished) proxy.destroy(); });
      req.pipe(proxy); return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { fail(405, 'METHOD_NOT_ALLOWED'); return; }
    try {
      const pathname = decodeURIComponent(raw.split('?')[0] ?? '/');
      if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some((p) => p.startsWith('.') || p === '_worker.js')) { fail(404, 'NOT_FOUND'); return; }
      let target = resolve(base, '.' + pathname);
      try { if (!(await stat(target)).isFile()) target = resolve(base, 'index.html'); }
      catch { if (extname(pathname)) { fail(404, 'NOT_FOUND'); return; } target = resolve(base, 'index.html'); }
      target = await realpath(target);
      if (!target.startsWith(base + sep)) { fail(404, 'NOT_FOUND'); return; }
      const info = await stat(target);
      res.writeHead(200, { 'content-type': MIME[extname(target)] ?? 'application/octet-stream', 'content-length': info.size,
        'x-content-type-options': 'nosniff', 'cache-control': 'no-cache' });
      if (req.method === 'HEAD') { res.end(); return; }
      createReadStream(target).on('error', () => res.destroy()).pipe(res);
    } catch { fail(404, 'NOT_FOUND'); }
  });
}

async function main() {
  if (process.env.CHAIN_ID !== '97' || !process.env.API_INTERNAL_URL) throw new Error('missing testnet website configuration');
  const port = Number(process.env.PORT || '8080');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid port');
  const server = await createTestnetWebsite(process.env.WEBSITE_DIST || 'website', new URL(process.env.API_INTERNAL_URL));
  server.listen(port, '::');
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close());
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('[testnet-website] startup failed; check static files and API origin'); process.exitCode = 1; });
}
