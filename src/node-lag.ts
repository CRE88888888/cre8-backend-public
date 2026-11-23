/**
 * The chain-97 RPC is load-balanced: right after a transaction lands, the node answering a read can still be a few
 * blocks behind the one that served the receipt (the same lag `untilNodesCatchUp` absorbs for My mix). A read that
 * must see the user's just-landed transaction retries briefly before it reports "not there".
 */
export const NODE_LAG_BUDGET_MS = 10_000;
export type NodeLagOptions = { budgetMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number };

/** Re-run `read` while `lagging(error)` says it only failed because the node is behind; any other error is thrown at once. */
export async function retryWhileLagging<T>(read: () => Promise<T>, lagging: (error: unknown) => boolean, options: NodeLagOptions = {}): Promise<T> {
  const budget = options.budgetMs ?? NODE_LAG_BUDGET_MS, now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const started = now();
  for (let delay = 300; ; delay = Math.min(delay * 2, 2000)) {
    try { return await read(); }
    catch (error) {
      if (!lagging(error) || now() - started + delay > budget) throw error;
      await sleep(delay);
    }
  }
}
