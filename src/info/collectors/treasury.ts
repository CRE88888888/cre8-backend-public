import { day, decimal, elements, object, scalar, xml } from '../source.js';
import type { InfoBatch, InfoGet, MarketSnapshot } from '../types.js';
export const treasuryUrl = (year: number) => `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value=${year}`;
export function parseTreasury(raw: string, url: string): InfoBatch {
  const root = xml(raw);
  if (root.feed === '') return { events: [], markets: [] };
  const feed = object(root.feed);
  const markets: MarketSnapshot[] = elements(feed.entry).flatMap(entry => {
    const properties = object(object(object(entry).content).properties);
    const observedOn = day(scalar(properties.NEW_DATE).slice(0, 10));
    return ([['BC_2YEAR', 'ust_2y'], ['BC_10YEAR', 'ust_10y']] as const).flatMap(([field, series]) => {
      const value = properties[field];
      if (value === undefined || (typeof value === 'object' && value !== null && object(value)['@_null'] === 'true')) return [];
      return [{ series, observedOn, value: decimal(value), source: 'treasury', sourceUrl: url }];
    });
  });
  return { events: [], markets: markets.filter(row => markets.filter(other => other.series === row.series && other.observedOn > row.observedOn).length < 2) };
}
export const treasuryCollector = (get: InfoGet, now: () => Date) => ({ name: 'treasury', collect: async (): Promise<InfoBatch> => {
  const url = treasuryUrl(now().getUTCFullYear());
  const batch = parseTreasury(await get(url), url);
  if (batch.markets.length >= 4) return batch;
  const previous = treasuryUrl(now().getUTCFullYear() - 1);
  return { events: [], markets: [...batch.markets, ...parseTreasury(await get(previous), previous).markets]
    .sort((a, b) => b.observedOn.localeCompare(a.observedOn)).filter((row, index, rows) => rows.slice(0, index).filter(other => other.series === row.series).length < 2) };
} });
