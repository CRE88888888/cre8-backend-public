import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { getConfig } from './config.js';
import { query } from './db.js';
import { AppError, ValidationError } from './errors.js';
import { createStrategy, getStrategy, listStrategies } from './strategies.js';

/** Hard cap on request bodies: strategy payloads are small; anything bigger is a mistake or an attack. */
const MAX_BODY_BYTES = 1_000_000;

/**
 * Error codes that mean "the database is unreachable" rather than "your request is wrong".
 * These become 503 so a load balancer can take the instance out of rotation.
 */
const DB_DOWN_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  '08000',
  '08001',
  '08006',
  '57P01',
  '57P03',
]);

export function createServer(): Server {
  return createHttpServer((req, res) => {
    void handleRequest(req, res);
  });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const startedAt = Date.now();
  const method = req.method ?? 'GET';
  let path = req.url ?? '/';

  res.on('finish', () => {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'info',
        msg: 'http_request',
        method,
        path,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
      }),
    );
  });

  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    path = url.pathname;
    await route(req, res, url);
  } catch (err) {
    sendError(res, err);
  }
}

async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = req.method ?? 'GET';
  const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
  const [root] = segments;

  if (root === 'health' && segments.length === 1) {
    if (method !== 'GET') return methodNotAllowed(res, ['GET']);
    return health(res);
  }

  if (root === 'strategies') {
    if (segments.length === 1) {
      if (method === 'GET') return listRoute(res, url);
      if (method === 'POST') return createRoute(req, res);
      return methodNotAllowed(res, ['GET', 'POST']);
    }
    if (segments.length === 2) {
      if (method !== 'GET') return methodNotAllowed(res, ['GET']);
      return detailRoute(res, parsePositiveInteger(segments[1] ?? '', 'strategy id'));
    }
  }

  sendJson(res, 404, {
    error: { code: 'NOT_FOUND', message: `no route for ${method} ${url.pathname}` },
  });
}

/** GET /health — 200 when Postgres answers, 503 otherwise. chainId is the configured default chain. */
async function health(res: ServerResponse): Promise<void> {
  const config = getConfig();
  let db: 'ok' | 'down' = 'ok';
  try {
    await query('select 1');
  } catch {
    db = 'down';
  }

  sendJson(res, db === 'ok' ? 200 : 503, {
    status: db === 'ok' ? 'ok' : 'degraded',
    service: 'cre8-atp-backend',
    chainId: config.chainId,
    rpcConfigured: config.rpcUrl !== null,
    db,
    uptimeSeconds: Math.round(process.uptime()),
  });
}

/** GET /strategies?limit=50&offset=0&provider=0x…&public=true */
async function listRoute(res: ServerResponse, url: URL): Promise<void> {
  const provider = url.searchParams.get('provider')?.trim() ?? '';
  const page = await listStrategies({
    limit: parseQueryInteger(url.searchParams.get('limit'), 'limit'),
    offset: parseQueryInteger(url.searchParams.get('offset'), 'offset'),
    provider: provider === '' ? undefined : provider,
    isPublic: parseBoolean(url.searchParams.get('public'), 'public'),
  });
  sendJson(res, 200, page);
}

/** GET /strategies/:id — metadata plus version history (newest first). */
async function detailRoute(res: ServerResponse, id: number): Promise<void> {
  sendJson(res, 200, await getStrategy(id));
}

/** POST /strategies — create metadata only; versions are published separately. */
async function createRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const strategy = await createStrategy(body);
  sendJson(res, 201, strategy, { location: `/strategies/${strategy.id}` });
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new AppError(413, 'PAYLOAD_TOO_LARGE', `request body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(buffer);
  }

  if (size === 0) {
    throw new ValidationError('INVALID_JSON', 'request body is required and must be JSON');
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ValidationError('INVALID_JSON', 'request body must be valid JSON');
  }
}

function parsePositiveInteger(raw: string, name: string): number {
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new ValidationError('INVALID_ID', `${name} must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new ValidationError('INVALID_ID', `${name} is out of range`);
  }
  return value;
}

function parseQueryInteger(raw: string | null, name: string): number | undefined {
  if (raw === null) return undefined;
  if (!/^-?\d+$/.test(raw)) {
    throw new ValidationError('INVALID_QUERY', `${name} must be an integer`);
  }
  return Number(raw);
}

function parseBoolean(raw: string | null, name: string): boolean | undefined {
  if (raw === null) return undefined;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new ValidationError('INVALID_QUERY', `${name} must be "true" or "false"`);
}

function methodNotAllowed(res: ServerResponse, allowed: string[]): void {
  sendJson(
    res,
    405,
    { error: { code: 'METHOD_NOT_ALLOWED', message: `method not allowed; use ${allowed.join(', ')}` } },
    { allow: allowed.join(', ') },
  );
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function sendError(res: ServerResponse, err: unknown): void {
  if (res.headersSent || res.writableEnded) {
    res.end();
    return;
  }

  if (err instanceof AppError) {
    sendJson(res, err.status, { error: { code: err.code, message: err.message } });
    return;
  }

  const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code?: unknown }).code) : '';
  if (DB_DOWN_CODES.has(code)) {
    sendJson(res, 503, { error: { code: 'DB_UNAVAILABLE', message: 'database unavailable' } });
    return;
  }

  console.error(
    JSON.stringify({
      level: 'error',
      msg: 'unhandled request error',
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    }),
  );
  sendJson(res, 500, { error: { code: 'INTERNAL', message: 'internal server error' } });
}
