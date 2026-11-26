import { day, decimal } from '../source.js';
import { InfoSourceError } from '../types.js';
import type { InfoBatch, InfoGet, MarketSnapshot } from '../types.js';
export const FRED_URL = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=DTWEXBGS';
export function parseFred(raw: string): InfoBatch {
  const [header, ...lines] = raw.trim().split(/\r?\n/);
  if (!['observation_date,DTWEXBGS', 'DATE,DTWEXBGS'].includes(header ?? '')) throw new InfoSourceError('invalid_csv');
  const markets: MarketSnapshot[] = lines.filter(line => line.trim()).flatMap(line => {
    const columns = line.split(',');
    if (columns.length !== 2) throw new InfoSourceError('invalid_csv');
    const observedOn = day(columns[0]);
    if (columns[1] === '.' || columns[1] === '') return [];
    return [{ series: 'usd_broad', observedOn, value: decimal(columns[1]), source: 'fred', sourceUrl: FRED_URL }];
  });
  return { events: [], markets: markets.sort((a, b) => b.observedOn.localeCompare(a.observedOn)).slice(0, 2) };
}
export const fredCollector = (get: InfoGet) => ({ name: 'fred', collect: async () => parseFred(await get(FRED_URL)) });
