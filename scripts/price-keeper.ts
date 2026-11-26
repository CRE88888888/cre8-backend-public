import { runPriceKeeper } from '../src/keeper/run.js';
import { startWorkerHealth } from '../src/worker-health.js';

let stopHealth: () => Promise<void> = async () => {};
try {
  const args = process.argv.slice(2);
  if (args.length === 0) stopHealth = await startWorkerHealth();
  await runPriceKeeper(args);
} catch {
  console.error('[price-keeper] stopped; check worker readiness and keeper logs');
  process.exitCode = 1;
} finally {
  await stopHealth();
}
