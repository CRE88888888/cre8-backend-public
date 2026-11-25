import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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


/** Chain-97 crypto assets that have no secondary feed; they trade around the clock like the feed-backed ones. */
export const TESTNET_CRYPTO_WITHOUT_FEED: ReadonlySet<string> = new Set(['ADA','LINK','BCH','NEAR','UNI','ZEC','TONCOIN','DOT','SHIB','PEPE','AAVE','Cake','FIL','ATOM']);
export type TestnetAssetKind = 'stock' | 'crypto' | 'gold';
/** Only stocks/ETFs follow the NYSE session; unknown symbols fail closed as stocks. */
export function testnetAssetKind(symbol: string): TestnetAssetKind {
  if (symbol === 'XAUt') return 'gold';
  const spec = TESTNET_ASSETS.find(a => a.symbol === symbol);
  return spec?.hasFeed || TESTNET_CRYPTO_WITHOUT_FEED.has(symbol) ? 'crypto' : 'stock';
}

/**
 * deploy/market-hours-bypass.json: `{ chainId: 97, owners: [...] }`, the test wallets whose portfolios skip the stock
 * session on chain 97. Only a file that says `chainId: 97` names anyone; a missing or malformed file, another chain id
 * or a malformed entry names nobody (the calendar then applies to everyone, which is the safe side).
 */
export function parseMarketHoursBypass(text:string|null):ReadonlySet<string> {
  if(text===null)return new Set();
  let file:unknown;
  try{file=JSON.parse(text);}catch{return new Set();}
  if(typeof file!=='object'||file===null)return new Set();
  const {chainId,owners}=file as {chainId?:unknown;owners?:unknown};
  if(chainId!==97||!Array.isArray(owners)||owners.some(o=>typeof o!=='string'||!/^0x[0-9a-fA-F]{40}$/.test(o)))return new Set();
  return new Set((owners as string[]).map(o=>o.toLowerCase()));
}
let bypassOwners:ReadonlySet<string>|undefined;
function marketHoursBypassOwners():ReadonlySet<string> {
  if(bypassOwners===undefined){
    let text:string|null=null;
    try{text=readFileSync(fileURLToPath(new URL('../deploy/market-hours-bypass.json',import.meta.url)),'utf8');}catch{/* no file in this build: nobody */}
    bypassOwners=parseMarketHoursBypass(text);
  }
  return bypassOwners;
}
/**
 * Does this owner's portfolio skip the stock session? Chain 97 only, whatever the list says: on chain 56 (and any other
 * chain) the answer is always no. `owner` is `smart_accounts.owner` (the wallet the user signs in with), never a request field.
 */
export function marketHoursBypassed(chainId:number,owner:string|null|undefined,owners:ReadonlySet<string>=marketHoursBypassOwners()):boolean {
  return chainId===97&&typeof owner==='string'&&owners.has(owner.toLowerCase());
}

/** Asset identity comes from the admitted chain manifest, never a request symbol.
 * `owner`: the portfolio's owner, when the caller has one; an owner on the chain-97 bypass list is always open. */
export function assetsMarketOpen(chainId:number,assets:readonly string[],now:Date,owner?:string|null):boolean {
  if(chainId!==97)return true;
  if(marketHoursBypassed(chainId,owner))return true;
  const stocks=new Set<string>(TESTNET_ASSETS.filter(a=>testnetAssetKind(a.symbol)==='stock').map(a=>a.symbol));
  const addresses=new Set<string>(testnetAssets().filter(a=>stocks.has(a.symbol)).map(a=>a.address));
  return !assets.some(a=>addresses.has(a.toLowerCase()))||stockMarketOpen(now);
}
