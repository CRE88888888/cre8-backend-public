import { instant, json, object, sourceUrl, text } from '../source.js';
import { InfoSourceError } from '../types.js';
import type { InfoBatch, InfoEvent, InfoGet } from '../types.js';
export const STRATEGY_URL = 'https://www.strategy.com/press';

function plain(raw: string): string {
  return raw.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/\s+/g, ' ').trim();
}
const purchase = (title: string): boolean => /\b(acquires?|purchases?|buys?|bought)\b/i.test(title) && /\b(bitcoins?|BTC)\b/i.test(title);

export function strategyLinks(raw: string): string[] {
  if (!/<html\b|<a\b/i.test(raw)) throw new InfoSourceError('invalid_html');
  const urls = new Set<string>();
  for (const match of raw.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi)) {
    if (!purchase(plain(match[2] ?? ''))) continue;
    const url = sourceUrl(new URL(plain(match[1] ?? ''), STRATEGY_URL).href, ['www.strategy.com']);
    if (new URL(url).pathname.startsWith('/press/')) urls.add(url);
  }
  return [...urls].slice(0, 20);
}

export function parseStrategyArticle(raw: string, url: string): InfoEvent {
  let headline: string | undefined, date: string | undefined;
  let timeBasis = 'source_publication_time';
  const inspect = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(inspect); return; }
    const item = object(value);
    if (item['@graph'] !== undefined) inspect(item['@graph']);
    if (typeof item.headline === 'string' && typeof item.datePublished === 'string') {
      headline = item.headline; date = item.datePublished;
    }
  };
  for (const match of raw.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)) inspect(json(match[1] ?? ''));
  if (!headline) {
    const heading = raw.match(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i);
    if (heading?.[1]) headline = plain(heading[1]);
  }
  if (!date) {
    const published = raw.match(/<time\b[^>]*datetime\s*=\s*["']([^"']+)["']/i);
    if (published?.[1]) date = plain(published[1]);
  }
  if (!date) {
    // The official rendered article visibly labels its date next to "Press Release".
    const published = plain(raw).match(/Press Release\s*[•·|]\s*([A-Z][a-z]+ \d{1,2}, \d{4})/);
    if (published?.[1]) { date = instant(`${published[1]} UTC`).slice(0, 10); timeBasis = 'source_publication_date'; }
  }
  if (!headline || !date || !purchase(headline)) throw new InfoSourceError('strategy_article_missing_metadata');
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) timeBasis = 'source_publication_date';
  return { category: 'person', kind: 'btc_purchase', source: 'strategy', sourceRef: sourceUrl(url, ['www.strategy.com']),
    occurredAt: instant(date), titleEn: text(headline), assetSymbols: ['MSTR', 'BTC'], sourceUrl: url,
    payload: { coverage: 'official_press_purchase_announcements', datePublished: date, timeBasis } };
}
export const strategyCollector = (get: InfoGet) => ({ name: 'strategy', collect: async (): Promise<InfoBatch> => {
  const links = strategyLinks(await get(STRATEGY_URL));
  const events: InfoEvent[] = [];
  for (const url of links) events.push(parseStrategyArticle(await get(url), url));
  return { events, markets: [] };
} });
