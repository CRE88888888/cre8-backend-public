/** Deployment readiness only. No config, DB, signer or RPC module is loaded. */
import { createServer } from 'node:http';

const port = Number(process.env.PORT || '8080');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid hold port');
const server = createServer((req, res) => {
  const health = req.method === 'GET' && req.url === '/health';
  res.writeHead(health ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ status: 'disabled', code: 'TESTNET_NOT_ACTIVATED' }));
});
server.listen(port, '::');
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close());
