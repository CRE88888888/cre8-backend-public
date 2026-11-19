// Official read-only GETs and information tables only. No trading/chain dependencies.
import { config as loadDotenv } from 'dotenv';
import { closePool } from '../src/db.js';
import { createInfoJob } from '../src/info/job.js';
loadDotenv({ override: false });
try { await createInfoJob()(); }
catch { console.error('[info_collectors] job unavailable; check configuration, state directory and database'); process.exitCode = 1; }
finally { await closePool(); }
