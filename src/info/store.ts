import { withTransaction } from '../db.js';
import type { InfoBatch } from './types.js';

/** Re-fetches may refresh unreviewed rows only. Published/rejected/reviewed facts are frozen for human review. */
export async function saveInfoBatch(batch: InfoBatch, transaction = withTransaction): Promise<{ events: number; markets: number }> {
  return transaction(async client => {
    const saved = { events: 0, markets: 0 };
    for (const event of batch.events) {
      const result = await client.query(`insert into info_events(category,kind,source,source_ref,occurred_at,title_en,actual,unit,asset_symbols,source_url,payload)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        on conflict(source,source_ref) do update set occurred_at=excluded.occurred_at,title_en=excluded.title_en,
          actual=excluded.actual,unit=excluded.unit,asset_symbols=excluded.asset_symbols,source_url=excluded.source_url,
          payload=excluded.payload,updated_at=now()
        where info_events.status='collected' and
          (info_events.occurred_at,info_events.title_en,info_events.actual,info_events.unit,info_events.asset_symbols,info_events.source_url,info_events.payload)
          is distinct from (excluded.occurred_at,excluded.title_en,excluded.actual,excluded.unit,excluded.asset_symbols,excluded.source_url,excluded.payload)
        returning id`, [event.category, event.kind, event.source, event.sourceRef, event.occurredAt, event.titleEn,
        event.actual ?? null, event.unit ?? null, event.assetSymbols, event.sourceUrl, JSON.stringify(event.payload)]);
      saved.events += result.rows.length;
    }
    for (const market of batch.markets) {
      const result = await client.query(`insert into market_snapshots(series,observed_on,value,source,source_url) values($1,$2,$3,$4,$5)
        on conflict(series,observed_on) do update set value=excluded.value,source=excluded.source,source_url=excluded.source_url
        where (market_snapshots.value,market_snapshots.source,market_snapshots.source_url)
          is distinct from (excluded.value,excluded.source,excluded.source_url) returning id`,
      [market.series, market.observedOn, market.value, market.source, market.sourceUrl]);
      saved.markets += result.rows.length;
    }
    return saved;
  });
}
