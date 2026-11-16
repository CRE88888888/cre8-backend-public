/** Opt-in scripts require an explicitly selected local lane before creating clients or services. */
export function localAcceptanceEnv(env: NodeJS.ProcessEnv, needsBundler = false) {
  const fail = () => new Error('local acceptance requires chain 97, explicit distinct localhost ports and a matching TEST_DATABASE_NAME');
  const endpoint = (raw: string | undefined) => {
    if (!raw) throw fail();
    let url: URL;
    try { url = new URL(raw); } catch { throw fail(); }
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        !url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw fail();
    return url;
  };
  const port = Number(env.PORT);
  if (env.CHAIN_ID !== '97' || !env.PORT || !/^[0-9]+$/.test(env.PORT) || !Number.isInteger(port) || port < 1024 || port > 65535) throw fail();
  const rpc = endpoint(env.RPC_URL);
  let database: URL;
  try { database = new URL(env.DATABASE_URL ?? ''); } catch { throw fail(); }
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname) ||
      !env.TEST_DATABASE_NAME || !/^cre8_[a-zA-Z0-9_]+$/.test(env.TEST_DATABASE_NAME) || database.pathname !== '/' + env.TEST_DATABASE_NAME) throw fail();
  const bundler = needsBundler ? endpoint(env.BUNDLER_URL) : null;
  const ports = [Number(rpc.port), port, ...(bundler ? [Number(bundler.port)] : [])];
  if (ports.some(p => p < 1024) || new Set(ports).size !== ports.length) throw fail();
  return { rpcUrl: env.RPC_URL ?? '', apiUrl: `http://127.0.0.1:${port}`, backendPort: port,
    databaseName: env.TEST_DATABASE_NAME, bundler: bundler ? { url: env.BUNDLER_URL ?? '', port: Number(bundler.port) } : null };
}
