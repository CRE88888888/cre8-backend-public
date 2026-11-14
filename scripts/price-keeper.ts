import { runPriceKeeper } from '../src/keeper/run.js';

runPriceKeeper(process.argv.slice(2)).catch(() => { process.exitCode = 1; });
