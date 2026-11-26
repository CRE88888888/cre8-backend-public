import { query } from '../db.js';
import { AppError, NotFoundError, ValidationError } from '../errors.js';
import { affectedFunds, companySymbol, readInfoCatalogue, symbolAliases } from './catalogue.js';
import type { InfoFund, InfoQuery } from './catalogue.js';

function positive(raw: string, name: string): string {
  if (!/^[1-9]\d{0,18}$/.test(raw) || BigInt(raw) > 9_223_372_036_854_775_807n) throw new ValidationError('INVALID_INFO_QUERY', `${name} must be a positive bigint`);
  return raw;
}
function filterTime(raw: string | null): string | null {
  if (raw === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(raw) ||
      !Number.isFinite(Date.parse(raw))) throw new ValidationError('INVALID_INFO_QUERY', 'from/to must be ISO dates or timestamps with timezone');
  const calendarDate = raw.slice(0, 10);
  if (new Date(calendarDate).toISOString().slice(0, 10) !== calendarDate) throw new ValidationError('INVALID_INFO_QUERY', 'from/to contains an invalid calendar date');
  return new Date(raw).toISOString();
}

export function parseInfoFilters(params: URLSearchParams) {
  const category = params.get('category'), include = params.get('include');
  if (category !== null && !['economy', 'company', 'person'].includes(category)) throw new ValidationError('INVALID_INFO_QUERY', 'category must be economy, company or person');
  if (include !== null && include !== 'collected') throw new ValidationError('INVALID_INFO_QUERY', 'include must be collected');
  const from = filterTime(params.get('from')), to = filterTime(params.get('to'));
  if (from !== null && to !== null && from > to) throw new ValidationError('INVALID_INFO_QUERY', 'from must not be after to');
  const rawLimit = params.get('limit') ?? '50';
  if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 100) throw new ValidationError('INVALID_INFO_QUERY', 'limit must be in 1..100');
  const fund = params.get('fund');
  return { category, from, to, fund: fund === null ? null : positive(fund, 'fund'), limit: Number(rawLimit), includeCollected: include === 'collected' };
}
export type InfoFilters = ReturnType<typeof parseInfoFilters>;

export function createInfoService(deps: { query?: InfoQuery; catalogue?: () => Promise<InfoFund[]> } = {}) {
  const run = deps.query ?? query;
  const catalogue = deps.catalogue ?? (() => readInfoCatalogue(run));
  const safe = async <T>(action: () => Promise<T>): Promise<T> => {
    try { return await action(); } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(503, 'INFO_UNAVAILABLE', 'information data temporarily unavailable');
    }
  };
  return {
    async events(filters: InfoFilters) {
      return safe(async () => {
        const funds = await catalogue();
        const fundSymbols = filters.fund === null ? null : funds.find(fund => fund.id === filters.fund)?.assetSymbols ?? [];
        // Catalogue symbols may be token symbols (NVDAB) or exchange tickers (NVDA).
        const symbols = fundSymbols === null ? null : [...new Set(fundSymbols.flatMap(symbolAliases))];
        const companySymbols = fundSymbols === null ? null : [...new Set(fundSymbols.filter(companySymbol).flatMap(symbolAliases))];
        const rows = (await run(`select id::text, category,kind,source,source_ref,scheduled_at,occurred_at,title_en,title_zh,
            actual,expected,unit,asset_symbols,source_url,status,reviewed_by,reviewed_at,
            payload->>'timeBasis' as time_basis,payload->>'referencePeriod' as reference_period,
            payload->'releaseDateAvailable' as release_date_available
          from info_events where ($1::boolean or status='published')
            and ($2::text is null or category=$2)
            and ($3::timestamptz is null or coalesce(occurred_at,scheduled_at)>=$3)
            and ($4::timestamptz is null or coalesce(occurred_at,scheduled_at)<=$4)
            and ($5::text[] is null or asset_symbols && $5)
            and (category<>'company' or $6::text[] is null or asset_symbols && $6)
          order by coalesce(occurred_at,scheduled_at) desc,id desc limit $7`,
        [filters.includeCollected, filters.category, filters.from, filters.to, symbols, companySymbols, filters.limit])).rows;
        return { events: rows.map(row => {
          const eventSymbols = row.asset_symbols;
          if (!Array.isArray(eventSymbols) || !eventSymbols.every((symbol: unknown): symbol is string => typeof symbol === 'string')) throw new Error('invalid info symbols');
          return { id: row.id, category: row.category, kind: row.kind, source: row.source, sourceRef: row.source_ref,
            scheduledAt: row.scheduled_at, occurredAt: row.occurred_at, titleEn: row.title_en, titleZh: row.title_zh,
            actual: row.actual, expected: row.expected, unit: row.unit, assetSymbols: eventSymbols,
            sourceUrl: row.source_url, status: row.status, affectedFunds: affectedFunds(eventSymbols, funds, row.category),
            timeBasis: row.time_basis ?? 'source_publication_time', referencePeriod: row.reference_period ?? null,
            releaseDateAvailable: row.release_date_available ?? true,
            ...(filters.includeCollected ? { reviewedBy: row.reviewed_by, reviewedAt: row.reviewed_at } : {}) };
        }), limit: filters.limit };
      });
    },
    async markets() {
      return safe(async () => {
        const rows = (await run(`with history as (
          select series,observed_on,value,source,source_url,
            (value-lag(value) over(partition by series order by observed_on))::text as change,
            row_number() over(partition by series order by observed_on desc) as position
          from market_snapshots where series in ('ust_2y','ust_10y','usd_broad'))
          select series,observed_on::text,value::text,source,source_url,change,position::integer from history
          where position<=2 order by series,position`)).rows;
        return { markets: (['ust_2y', 'ust_10y', 'usd_broad'] as const).map(series => {
          const points = rows.filter(row => row.series === series).map(row => ({ observedOn: row.observed_on,
            value: row.value, source: row.source, sourceUrl: row.source_url }));
          return { series, label: series === 'usd_broad' ? '廣義貿易加權美元指數（DTWEXBGS，非 DXY）' : `美國公債 ${series === 'ust_2y' ? '2' : '10'} 年殖利率`,
            unit: series === 'usd_broad' ? 'index_jan_2006_100' : 'percent', points,
            change: points.length < 2 ? null : rows.find(row => row.series === series && row.position === 1)?.change ?? null,
            changeUnit: series === 'usd_broad' ? 'index_points' : 'percentage_points' };
        }) };
      });
    },
    async review(id: string, input: unknown, wallet: string) {
      positive(id, 'event id');
      if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new ValidationError('INVALID_INFO_REVIEW', 'review body must be an object');
      const title = Reflect.get(input, 'title_zh'), status: unknown = Reflect.get(input, 'status');
      if (Object.keys(input).some(key => !['title_zh', 'status'].includes(key)) || typeof title !== 'string' ||
          !title.trim() || title.trim().length > 500 || typeof status !== 'string' || !['reviewed', 'published', 'rejected'].includes(status)) {
        throw new ValidationError('INVALID_INFO_REVIEW', 'title_zh must have 1..500 characters and status must be reviewed, published or rejected');
      }
      return safe(async () => {
        const row = (await run(`update info_events set title_zh=$2,status=$3,reviewed_by=$4,reviewed_at=now(),updated_at=now()
          where id=$1 returning id::text,title_zh,status,reviewed_by,reviewed_at`, [id, title.trim(), status, wallet.toLowerCase()])).rows[0];
        if (!row) throw new NotFoundError('info event not found');
        return { id: row.id, titleZh: row.title_zh, status: row.status, reviewedBy: row.reviewed_by, reviewedAt: row.reviewed_at };
      });
    },
  };
}
