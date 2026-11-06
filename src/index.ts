import { getConfig } from './config.js';
import { closePool, migrate } from './db.js';
import { createServer } from './server.js';

/** Entrypoint: fail fast on config, bring the schema up to date, then listen. */
async function main(): Promise<void> {
  const config = getConfig();

  const { applied } = await migrate();
  if (applied.length > 0) {
    console.log(JSON.stringify({ level: 'info', msg: 'migrations applied', files: applied }));
  } else {
    console.log(JSON.stringify({ level: 'info', msg: 'migrations up to date' }));
  }

  const server = createServer();
  server.listen(config.port, () => {
    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'cre8-atp-backend listening',
        port: config.port,
        chainId: config.chainId,
        rpcConfigured: config.rpcUrl !== null,
      }),
    );
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(JSON.stringify({ level: 'info', msg: 'shutting down', signal }));

    const forceExit = setTimeout(() => {
      console.error(JSON.stringify({ level: 'error', msg: 'shutdown timed out, forcing exit' }));
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closePool();
    clearTimeout(forceExit);
    process.exit(0);
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }
}

main().catch((err: unknown) => {
  console.error(
    JSON.stringify({
      level: 'error',
      msg: 'startup failed',
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    }),
  );
  process.exitCode = 1;
});
