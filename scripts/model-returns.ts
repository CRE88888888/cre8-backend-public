// Public Yahoo/Binance GETs and market_snapshots only. No trading or signing configuration is needed.
import { config as loadDotenv } from 'dotenv';
import { closePool } from '../src/db.js';
import { createCloseJob } from '../src/model-returns/collector.js';
loadDotenv({ override: false });
try {
  const results = await createCloseJob()();
  if (results.some(result => result.error !== null)) process.exitCode = 1;
} catch { console.error('[model_returns] collection unavailable; retry next daily round'); process.exitCode = 1; }
finally { await closePool(); }
