export type InfoEvent = {
  category: 'economy' | 'company' | 'person';
  kind: string;
  source: string;
  sourceRef: string;
  occurredAt: string;
  titleEn: string;
  actual?: string;
  unit?: string;
  assetSymbols: string[];
  sourceUrl: string;
  payload: Record<string, unknown>;
};

export type MarketSnapshot = {
  series: 'ust_2y' | 'ust_10y' | 'usd_broad';
  observedOn: string;
  value: string;
  source: string;
  sourceUrl: string;
};

export type InfoBatch = { events: InfoEvent[]; markets: MarketSnapshot[] };
export const emptyBatch = (): InfoBatch => ({ events: [], markets: [] });
export type InfoCollector = { name: string; collect: () => Promise<InfoBatch> };
export type InfoGet = (url: string, headers?: Record<string, string>) => Promise<string>;

/** Only these fixed codes may cross the log boundary; never log upstream bodies or exceptions. */
export class InfoSourceError extends Error {
  constructor(readonly code: string) { super(code); }
}
export function failureCode(error: unknown): string {
  return error instanceof InfoSourceError ? error.code : 'dependency_unavailable';
}
