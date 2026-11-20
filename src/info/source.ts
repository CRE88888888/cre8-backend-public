import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { InfoSourceError } from './types.js';
import type { InfoGet } from './types.js';

const HOSTS = new Set(['www.federalreserve.gov', 'apps.bea.gov', 'www.bea.gov', 'api.bls.gov',
  'home.treasury.gov', 'fred.stlouisfed.org', 'www.sec.gov', 'data.sec.gov', 'www.strategy.com']);
export const MAX_SOURCE_BYTES = 4_000_000;
export function sourceUrl(raw: string, hosts: readonly string[] = [...HOSTS]): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new InfoSourceError('invalid_source_url'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !hosts.includes(url.hostname)) {
    throw new InfoSourceError('invalid_source_url');
  }
  return url.href;
}

export function createInfoGet(send: (url: string, init: RequestInit) => Promise<Response> = fetch,
  timeoutMs = 15_000, budgetMs = 30_000, clock = Date.now, hosts: readonly string[] = [...HOSTS]): InfoGet {
  let deadline: number | undefined;
  return async (raw, headers = {}) => {
    let url = sourceUrl(raw, hosts);
    deadline ??= clock() + budgetMs;
    const remaining = deadline - clock();
    if (remaining <= 0) throw new InfoSourceError('source_deadline');
    const signal = AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, remaining)));
    try {
      for (let redirects = 0; redirects <= 3; redirects++) {
        const response = await send(url, { method: 'GET', redirect: 'manual', signal,
          headers: { accept: 'application/json, application/xml, text/xml, text/csv, text/html', ...headers } });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          await response.body?.cancel();
          if (!location || redirects === 3) throw new InfoSourceError('redirect_limit');
          // Credentials/UA are never forwarded to a different source host.
          const target = sourceUrl(new URL(location, url).href, [new URL(url).hostname]);
          url = target;
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new InfoSourceError(`http_${response.status}`);
        }
        if (Number(response.headers.get('content-length')) > MAX_SOURCE_BYTES) {
          await response.body?.cancel();
          throw new InfoSourceError('response_too_large');
        }
        const reader = response.body?.getReader();
        if (!reader) return '';
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            bytes += next.value.byteLength;
            if (bytes > MAX_SOURCE_BYTES) throw new InfoSourceError('response_too_large');
            chunks.push(next.value);
          }
        } finally { await reader.cancel().catch(() => {}); }
        return Buffer.concat(chunks).toString('utf8');
      }
      throw new InfoSourceError('redirect_limit');
    } catch (error) {
      if (error instanceof InfoSourceError) throw error;
      throw new InfoSourceError(signal.aborted ? 'timeout' : 'network_unavailable');
    }
  };
}

export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new InfoSourceError('invalid_format');
  return Object.fromEntries(Object.entries(value));
}
export function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new InfoSourceError('invalid_format');
  return value;
}
export function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new InfoSourceError('missing_field');
  return value.trim();
}
export function json(raw: string): unknown {
  try { return JSON.parse(raw); } catch { throw new InfoSourceError('invalid_json'); }
}
export function xml(raw: string): Record<string, unknown> {
  // No DTD/custom entities; bounded public documents only. Keep source decimals as strings.
  if (/<!DOCTYPE|<!ENTITY/i.test(raw) || XMLValidator.validate(raw) !== true) throw new InfoSourceError('invalid_xml');
  const parsed: unknown = new XMLParser({ removeNSPrefix: true, parseTagValue: false,
    ignoreAttributes: false, parseAttributeValue: false, trimValues: true }).parse(raw);
  return object(parsed);
}
export function elements(value: unknown): unknown[] { return value === undefined ? [] : Array.isArray(value) ? value : [value]; }
export function scalar(value: unknown): string { return text(typeof value === 'object' && value !== null ? object(value)['#text'] : value); }
export function instant(value: unknown): string {
  const raw = text(value);
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) throw new InfoSourceError('invalid_date');
  return new Date(timestamp).toISOString();
}
export function day(value: unknown): string {
  const raw = text(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || instant(raw).slice(0, 10) !== raw) throw new InfoSourceError('invalid_date');
  return raw;
}
export function decimal(value: unknown): string {
  const raw = scalar(value);
  if (!/^-?\d+(?:\.\d+)?$/.test(raw)) throw new InfoSourceError('invalid_number');
  return raw;
}

export function rss(raw: string): Record<string, unknown>[] {
  const root = object(xml(raw).rss);
  if (root.channel === '') return [];
  const channel = object(root.channel);
  return elements(channel.item).map(object);
}
