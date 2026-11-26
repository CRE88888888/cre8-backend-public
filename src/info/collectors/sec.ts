import { instant, json, list, object, sourceUrl, text } from '../source.js';
import { InfoSourceError } from '../types.js';
import type { InfoBatch, InfoEvent, InfoGet } from '../types.js';
import type { InfoFund } from '../catalogue.js';
import { companySymbol, symbolAliases } from '../catalogue.js';
export const SEC_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';

export function parseSecTickers(raw: string): Map<string, string> {
  const tickers = new Map<string, string>();
  for (const value of Object.values(object(json(raw)))) {
    const row = object(value);
    if (!Number.isSafeInteger(row.cik_str) || Number(row.cik_str) <= 0 || Number(row.cik_str) > 9_999_999_999) throw new InfoSourceError('invalid_cik');
    tickers.set(text(row.ticker).toUpperCase(), String(row.cik_str).padStart(10, '0'));
  }
  return tickers;
}

export function parseSecSubmissions(raw: string, cik: string, symbols: string[]): InfoEvent[] {
  const data = object(json(raw));
  if (String(data.cik).padStart(10, '0') !== cik) throw new InfoSourceError('sec_cik_mismatch');
  if (data.entityType !== 'operating') return []; // No ETF/fund feeds in this company collector.
  const recent = object(object(data.filings).recent);
  const forms = list(recent.form), refs = list(recent.accessionNumber), docs = list(recent.primaryDocument), dates = list(recent.acceptanceDateTime);
  if ([refs, docs, dates].some(values => values.length !== forms.length)) throw new InfoSourceError('sec_array_mismatch');
  return forms.flatMap((form, index) => {
    if (!['8-K', '8-K/A', '4', '4/A'].includes(String(form))) return [];
    const accession = text(refs[index]), document = text(docs[index]);
    if (!/^\d{10}-\d{2}-\d{6}$/.test(accession) ||
        !document.split('/').every(segment => /^[a-zA-Z0-9_.-]+$/.test(segment) && !['.', '..'].includes(segment))) throw new InfoSourceError('invalid_sec_reference');
    const url = sourceUrl(`https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replaceAll('-', '')}/${document}`, ['www.sec.gov']);
    return [{ category: 'company' as const, kind: String(form).startsWith('8-K') ? 'sec_8k' : 'sec_form4', source: 'sec',
      sourceRef: accession, occurredAt: instant(dates[index]), titleEn: `${text(data.name)} — Form ${String(form)}`,
      assetSymbols: symbols, sourceUrl: url, payload: { cik, accessionNumber: accession, form,
        primaryDocument: document, coverage: 'issuer_recent_submissions_only', amendment: String(form).endsWith('/A') } }];
  });
}

export const secCollector = (get: InfoGet, userAgent: string | null, catalogue: () => Promise<InfoFund[]>,
  pause: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 150))) => ({ name: 'sec', collect: async (): Promise<InfoBatch> => {
  if (!userAgent) throw new InfoSourceError('disabled_missing_sec_user_agent');
  const funds = await catalogue();
  const symbols = [...new Set(funds.flatMap(fund => fund.assetSymbols).filter(companySymbol))];
  if (symbols.length === 0) return { events: [], markets: [] };
  const headers = { 'User-Agent': userAgent };
  const tickers = parseSecTickers(await get(SEC_TICKERS_URL, headers));
  const companies = new Map<string, string[]>();
  for (const symbol of symbols) {
    const ticker = symbolAliases(symbol).find(alias => tickers.has(alias));
    if (!ticker) continue;
    const cik = tickers.get(ticker);
    if (cik) companies.set(cik, [...new Set([...(companies.get(cik) ?? []), ticker])]);
  }
  const batch: InfoBatch = { events: [], markets: [] };
  for (const [cik, related] of companies) {
    await pause();
    batch.events.push(...parseSecSubmissions(await get(`https://data.sec.gov/submissions/CIK${cik}.json`, headers), cik, related));
  }
  return batch;
} });
