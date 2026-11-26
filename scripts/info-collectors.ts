// Official GET collection and opt-in AI drafts; information tables only, no trading/chain dependencies.
import { config as loadDotenv } from 'dotenv';
import { closePool } from '../src/db.js';
import { createInfoBackgroundJob } from '../src/info/job.js';
loadDotenv({ override: false });
try { if (!await createInfoBackgroundJob()()) process.exitCode = 1; }
catch { console.error('[info_collectors] job unavailable; check configuration, state directory and database'); process.exitCode = 1; }
finally { await closePool(); }
