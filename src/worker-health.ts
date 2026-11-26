import { createServer } from 'node:http';

export function workerHealthPort(raw = '8080'): number {
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('worker readiness port invalid');
  }
  return port;
}

/** Process readiness only. Worker rounds and scheduler heartbeat remain the operational checks. */
export async function startWorkerHealth(env: NodeJS.ProcessEnv = process.env): Promise<() => Promise<void>> {
  if (env.CHAIN_ID !== '97' || env.SERVICE_ENABLED !== '1') return async () => {};
  const port = workerHealthPort(env.PORT);
  const server = createServer((req, res) => {
    res.writeHead(req.method === 'GET' && req.url === '/health' ? 200 : 404,
      { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(req.method === 'GET' && req.url === '/health' ? { status: 'ok' } : { code: 'NOT_FOUND' }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', () => reject(new Error('worker readiness unavailable')));
    server.listen(port, '::', resolve);
  });
  return async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}
