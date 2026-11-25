import type { Address } from 'viem';

/**
 * Strategy Earn after "sell all" (2026-11-26, testnet portfolio 35 on routing v2, portfolio 15 on v1).
 *
 * Earn extra is the buyer's choice at each buy. The consent itself lives on chain (v1: one borrow policy per market,
 * routing v2: one policy per account) and only the owner can withdraw it. "Sell all" is sent with the session key, which
 * cannot, and the owner's last signature (USDT back to the wallet) is built by the app, not here. So after everything
 * was sold the old consent stays enabled, and the scheduler read it as "open after the next fill": a later buy WITHOUT
 * Earn extra was posted and borrowed against all the same, and the portfolio's `autoOpen` turned true.
 *
 * The rule now: once a "sell all" has finished for an account, a consent counts only if the owner asked for it again
 * afterwards and that consent landed.
 *   - finished "sell all": the request row of src/sell-all-intent.ts in state `delivered` (the scheduler's
 *     [SELL_ALL_DONE], a `/close` that found nothing left, or the owner's new money arriving in an account that holds
 *     nothing but cash while the request was still open);
 *   - asked again: `POST /portfolios/:id/strategy-earn/auto` (the buy confirmation with Earn extra on, or the switch
 *     before a fill) answered `ready`. The app sends nothing when Earn extra is off, so no request = not chosen. The
 *     request is a row (kind `strategy_earn_consent`) whose payload is what the consent was about to replace: the
 *     ceiling on chain per v1 market id, or under `v2` for routing v2 (`0` when there was none);
 *   - landed: the chain's ceiling differs from what a request after the sale was about to replace. A request whose
 *     UserOp was never signed leaves the chain as it was, so it opens nothing; `distinctCeiling` makes sure a new
 *     consent never carries the very same ceiling as the old one.
 *
 * Only an account with nothing posted is held back: while a position is open (the owner bought more without selling
 * everything, or turned the strategy on by hand with `/open`) everything works as before. Rows are found by account, so
 * a My mix weight change (same account, new portfolio id) does not lose them. A portfolio without a cash ledger row
 * cannot hold either row and behaves as before.
 */
export const CONSENT_REQUEST_KIND = 'strategy_earn_consent';
/** `SELL_ALL_KIND` of src/sell-all-intent.ts, repeated here so this file imports nothing (test/strategy-earn-after-sell-all.test.ts keeps them equal). */
export const SOLD_KIND = 'sell_all_requested';
/** The routing v2 key of a `ConsentBefore` (v1 keys are market ids). */
export const V2_CONSENT_KEY = 'v2';
/** Debt ceilings on chain when the owner asked for consent, as decimal strings; `0` = no usable consent there. */
export type ConsentBefore = Record<string, string>;
/** null: no "sell all" has finished for this account — every consent counts, as before. Otherwise the requests made since. */
export type ConsentSinceSellAll = readonly ConsentBefore[] | null;

type Run = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;

/** `$1` chain id, `$2` account (lowercase). Rows of every portfolio id this account has had; `owner` lets the table's owner index serve the read. */
const OF_ACCOUNT = (n: string) => `${n}.chain_id = $1 and ${n}.owner in (select owner from acct) and ${n}.portfolio_id in (select portfolio_id from acct)`;
const SINCE_SQL = `with acct as (select a.portfolio_id, a.owner from smart_accounts a where a.chain_id = $1 and a.address = $2)
  select coalesce((select jsonb_agg(r.payload order by r.id) from user_notifications r
      where ${OF_ACCOUNT('r')} and r.kind = '${CONSENT_REQUEST_KIND}' and r.id > s.id), '[]'::jsonb) as requests
  from (select max(n.id) as id from user_notifications n where ${OF_ACCOUNT('n')} and n.kind = '${SOLD_KIND}' and n.state = 'delivered') s
 where s.id is not null`;
/** `$1` chain id, `$2` account (lowercase), `$3` payload. The account's current portfolio; nothing without a cash ledger row. */
const REQUEST_SQL = `insert into user_notifications (chain_id, portfolio_id, owner, kind, dedup_key, payload)
  select c.chain_id, c.portfolio_id, a.owner, '${CONSENT_REQUEST_KIND}',
         c.portfolio_id::text || ':' || (select count(*) + 1 from user_notifications e where e.chain_id = c.chain_id and e.portfolio_id = c.portfolio_id and e.kind = '${CONSENT_REQUEST_KIND}')::text,
         $3::jsonb
    from strategy_cash_balances c
    join smart_accounts a on (a.portfolio_id, a.chain_id, a.address) = (c.portfolio_id, c.chain_id, c.account)
   where c.chain_id = $1 and c.account = $2 and a.retired_at is null
   order by c.portfolio_id desc limit 1
  on conflict (chain_id, kind, dedup_key) do nothing`;

/** The owner's consent requests since this account's last finished "sell all"; null when there was none. */
export async function consentSinceSellAll(run: Run, chainId: number, account: Address): Promise<ConsentSinceSellAll> {
  const row = (await run(SINCE_SQL, [chainId, account.toLowerCase()])).rows[0] as { requests?: unknown } | undefined;
  if (row === undefined) return null;
  return Array.isArray(row.requests) ? row.requests.filter((r): r is ConsentBefore => typeof r === 'object' && r !== null) : [];
}

/** The owner asked for consent (`/strategy-earn/auto` is about to answer `ready`): `before` = what it will replace. */
export async function noteConsentRequest(run: Run, chainId: number, account: Address, before: ConsentBefore): Promise<void> {
  await run(REQUEST_SQL, [chainId, account.toLowerCase(), JSON.stringify(before)]);
}

/**
 * Is the consent on chain the one from before the sale? `current`: the usable ceilings now, by the same keys. False when
 * no "sell all" ever finished, or when some request since then was about to replace a different ceiling than the chain
 * holds now under the same key (that consent landed).
 */
export function consentIsStale(since: ConsentSinceSellAll, current: Readonly<Record<string, bigint>>): boolean {
  if (since === null) return false;
  const landed = (before: ConsentBefore) => Object.entries(before).some(([key, was]) => {
    const now = current[key];
    return now !== undefined && now > 0n && typeof was === 'string' && /^\d+$/.test(was) && now !== BigInt(was);
  });
  return !since.some(landed);
}

/** A new ceiling that can be told from the one it replaces. */
export const distinctCeiling = (planned: bigint, onChain: bigint) => planned === onChain ? planned + 1n : planned;
