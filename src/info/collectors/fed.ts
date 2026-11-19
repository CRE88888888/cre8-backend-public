import { instant, rss, sourceUrl, text } from '../source.js';
import type { InfoBatch, InfoGet } from '../types.js';
export const FED_URL = 'https://www.federalreserve.gov/feeds/press_monetary.xml';
export function parseFed(raw: string): InfoBatch {
  return { markets: [], events: rss(raw).map(item => {
    const title = text(item.title);
    const url = sourceUrl(text(item.link), ['www.federalreserve.gov']);
    const kind = /minutes of the federal open market committee/i.test(title) ? 'fomc_minutes'
      : /FOMC statement/i.test(title) ? 'fomc_statement'
      : /projection/i.test(title) ? 'fomc_projections' : 'monetary_policy';
    return { category: 'economy', kind, source: 'fed', sourceRef: typeof item.guid === 'string' ? item.guid : url,
      occurredAt: instant(item.pubDate), titleEn: title, assetSymbols: [], sourceUrl: url,
      payload: { description: item.description ?? null } };
  }) };
}
export const fedCollector = (get: InfoGet) => ({ name: 'fed', collect: async () => parseFed(await get(FED_URL)) });
