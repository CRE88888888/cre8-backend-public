import { TESTNET_ASSETS } from './keeper/assets.js';
import { testnetAssets } from './testnet-profile.js';

/** NYSE published 2026–2028 calendar. Unknown years fail closed.
 * https://ir.theice.com/press/news-details/2025/NYSE-Group-Announces-2026-2027-and-2028-Holiday-and-Early-Closings-Calendar/default.aspx
 * America/New_York supplies DST rules; only the regular equity session is eligible.
 */
const holidays = new Set([
  '2026-01-01','2026-01-19','2026-02-16','2026-04-03','2026-05-25','2026-06-19','2026-07-03','2026-09-07','2026-11-26','2026-12-25',
  '2027-01-01','2027-01-18','2027-02-15','2027-03-26','2027-05-31','2027-06-18','2027-07-05','2027-09-06','2027-11-25','2027-12-24',
  '2028-01-17','2028-02-21','2028-04-14','2028-05-29','2028-06-19','2028-07-04','2028-09-04','2028-11-23','2028-12-25',
]);
const early = new Set(['2026-11-27','2026-12-24','2027-11-26','2028-07-03','2028-11-24']);
const eastern = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export function stockMarketOpen(now: Date): boolean {
  if (!Number.isFinite(now.getTime())) throw new RangeError('invalid calendar time');
  const p = Object.fromEntries(eastern.formatToParts(now).map(part => [part.type,part.value]));
  const day = `${p.year}-${p.month}-${p.day}`;
  if (!['2026','2027','2028'].includes(p.year ?? '') || p.weekday === 'Sat' || p.weekday === 'Sun' || holidays.has(day)) return false;
  const minutes = Number(p.hour) * 60 + Number(p.minute);
  return minutes >= 570 && minutes < (early.has(day) ? 780 : 960);
}


/** Asset identity comes from the admitted chain manifest, never a request symbol. */
export function assetsMarketOpen(chainId:number,assets:readonly string[],now:Date):boolean {
  if(chainId!==97)return true;
  const stocks=new Set<string>(TESTNET_ASSETS.filter(a=>!a.hasFeed&&a.symbol!=='XAUt').map(a=>a.symbol));
  const addresses=new Set<string>(testnetAssets().filter(a=>stocks.has(a.symbol)).map(a=>a.address));
  return !assets.some(a=>addresses.has(a.toLowerCase()))||stockMarketOpen(now);
}
