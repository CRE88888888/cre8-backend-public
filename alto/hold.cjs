// Staged deployment: deliberately loads no bundler, RPC configuration or signer.
const { createServer } = require('node:http');
const port = Number(process.env.PORT || '3001');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid hold port');
const server = createServer((req, res) => {
  res.writeHead(req.method === 'GET' && req.url === '/health' ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ status: 'disabled', code: 'TESTNET_NOT_ACTIVATED' }));
});
server.listen(port, '::');
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close());
