import { instant, rss, sourceUrl, text } from '../source.js';
import type { InfoBatch, InfoGet } from '../types.js';
export const BEA_URL = 'https://apps.bea.gov/rss/rss.xml';
export function parseBea(raw: string): InfoBatch {
  return { markets: [], events: rss(raw).flatMap(item => {
    const title = text(item.title);
    const kind = /^(GDP|Gross Domestic Product)(?=\s*[(,]|$)/i.test(title) ? 'gdp'
      : /^Personal Income and Outlays\b/i.test(title) ? 'pce' : null;
    if (kind === null) return [];
    const link = text(item.link);
    // Recorded older national GDP entries omit their scheme. Only repair the official hosts.
    const url = sourceUrl(/^(www\.bea\.gov|apps\.bea\.gov)\//.test(link) ? `https://${link}` : link, ['www.bea.gov', 'apps.bea.gov']);
    return [{ category: 'economy' as const, kind, source: 'bea', sourceRef: url,
      occurredAt: instant(item.pubDate), titleEn: title, assetSymbols: [], sourceUrl: url,
      payload: { description: item.description ?? null } }];
  }) };
}
export const beaCollector = (get: InfoGet) => ({ name: 'bea', collect: async () => parseBea(await get(BEA_URL)) });
