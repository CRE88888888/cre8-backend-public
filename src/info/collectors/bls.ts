import { decimal, json, list, object, text } from '../source.js';
import { InfoSourceError } from '../types.js';
import type { InfoBatch, InfoGet } from '../types.js';

export const BLS_SERIES = [
  { id: 'CUSR0000SA0', kind: 'cpi', title: 'CPI, all urban consumers, seasonally adjusted', unit: 'index_1982_1984_100' },
  { id: 'CES0000000001', kind: 'nonfarm_payrolls', title: 'Total nonfarm payroll employment, seasonally adjusted', unit: 'thousand_persons' },
  { id: 'LNS14000000', kind: 'unemployment_rate', title: 'Unemployment rate, seasonally adjusted', unit: 'percent' },
] as const;

export function parseBls(raw: string, spec: typeof BLS_SERIES[number]): InfoBatch {
  const data = object(json(raw));
  if (data.status !== 'REQUEST_SUCCEEDED') throw new InfoSourceError('bls_request_failed');
  const series = list(object(data.Results).series).map(object).find(row => row.seriesID === spec.id);
  if (!series) throw new InfoSourceError('bls_series_missing');
  const observations = list(series.data).map(object).filter(row => /^M(0[1-9]|1[0-2])$/.test(text(row.period)));
  for (const row of observations) if (!/^\d{4}$/.test(text(row.year))) throw new InfoSourceError('invalid_date');
  observations.sort((a, b) => `${b.year}${b.period}`.localeCompare(`${a.year}${a.period}`));
  const latest = observations[0];
  if (!latest) return { events: [], markets: [] };
  const year = text(latest.year), month = text(latest.period).slice(1);
  const period = `${year}-${month}`;
  // v1 gives observation periods, not release timestamps. Explicitly preserve that distinction.
  const occurredAt = new Date(Date.UTC(Number(year), Number(month), 0)).toISOString();
  return { markets: [], events: [{ category: 'economy', kind: spec.kind, source: 'bls',
    sourceRef: `${spec.id}:${period}`, occurredAt, titleEn: `${spec.title}, ${period}`,
    actual: decimal(latest.value), unit: spec.unit, assetSymbols: [],
    sourceUrl: `https://api.bls.gov/publicAPI/v1/timeseries/data/${spec.id}`,
    payload: { seriesId: spec.id, referencePeriod: period, timeBasis: 'reference_period_end',
      releaseDateAvailable: false, footnotes: latest.footnotes ?? [] } }] };
}

export const BLS_POLL_MS = 4 * 60 * 60 * 1000;
export const blsCollector = (get: InfoGet, reserve: () => Promise<boolean>, now: () => number = Date.now) => {
  let nextPoll = 0;
  return { name: 'bls', collect: async (): Promise<InfoBatch> => {
    const batch: InfoBatch = { events: [], markets: [] };
    if (now() < nextPoll) return batch;
    nextPoll = now() + BLS_POLL_MS;
    for (const spec of BLS_SERIES) {
      if (!await reserve()) throw new InfoSourceError('bls_daily_limit');
      batch.events.push(...parseBls(await get(`https://api.bls.gov/publicAPI/v1/timeseries/data/${spec.id}`), spec).events);
    }
    return batch;
  } };
};
