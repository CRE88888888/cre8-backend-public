/**
 * 把一個投組的 smart account 入金，讓它能真的被再平衡。
 *
 * ## 為什麼需要這支
 * `POST /portfolios` 只部署帳戶與安裝 session key，**不會給它錢**。空倉的投組漂移是 5000 bps
 * （`drift.ts` 對 total = 0 的定義值），但有沒有部位可以搬 —— 所以它永遠 `noop`。
 * 要在 UI 上看到一次真的再平衡，帳戶裡必須先有 numeraire。
 *
 * ## 只入 numeraire（USDT），不直接發其他代幣
 * 直接發 NVDAB 給帳戶也能讓漂移變好看，但那就**跳過了真正要驗證的路徑**：規劃器 → 買入腿 →
 * impact 上限 → 上鏈。所以這裡只給 USDT，其餘交給一次真的再平衡去買 —— 那才是端到端。
 *
 * ## 只在 fork 上寫 storage
 * `anvil_setStorageAt` 直接改 `balanceOf` 的 slot。這在真鏈上不可能，所以這支腳本**只對本機 anvil**
 * 有效，且會先確認 RPC 是 localhost（避免有人指到主網）。
 *
 * 用法：
 *   RPC_URL=http://127.0.0.1:8545 DATABASE_URL=… bun run backend/scripts/fund-portfolio.ts \
 *     --portfolio 1599 --usd 20000
 *
 * Flags: --portfolio <id>（必填）--usd <amount>（預設 20000）--dry-run --gas-bnb <amount>（預設 1）
 */
import { createPublicClient, encodeAbiParameters, http, keccak256, parseUnits, toHex } from 'viem';
import type { Address, Hex, PublicClient } from 'viem';
import { closePool, query } from '../src/db.js';

const NUMERAIRES = new Set(['USDT']);

type Args = {
  portfolioId: number;
  usd: number;
  gasBnb: number;
  dryRun: boolean;
};

function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function parseArgs(argv: readonly string[]): Args {
  const portfolioRaw = flag(argv, 'portfolio');
  if (portfolioRaw === undefined) throw new Error('--portfolio <id> 是必填');
  const portfolioId = Number(portfolioRaw);
  if (!Number.isInteger(portfolioId) || portfolioId <= 0) throw new Error(`--portfolio 必須是正整數（收到 ${portfolioRaw}）`);

  const usdRaw = flag(argv, 'usd') ?? '20000';
  const usd = Number(usdRaw);
  if (!Number.isFinite(usd) || usd <= 0) throw new Error(`--usd 必須是正數（收到 ${usdRaw}）`);

  const gasRaw = flag(argv, 'gas-bnb') ?? '1';
  const gasBnb = Number(gasRaw);
  if (!Number.isFinite(gasBnb) || gasBnb < 0) throw new Error(`--gas-bnb 必須是 >= 0 的數（收到 ${gasRaw}）`);

  return { portfolioId, usd, gasBnb, dryRun: argv.includes('--dry-run') };
}

/**
 * `mapping(address => uint256)` 在某個 slot 的鍵：`keccak256(abi.encode(holder, slot))`。
 *
 * ⚠ **不能假設 slot 0**。BSC 的 USDT 是 proxy，實作的 `balances` 不在 slot 0 —— 實測寫 slot 0 之後
 * 回讀是 0。所以呼叫端要逐一試候選 slot，直到 `balanceOf` 對得上（見 `setBalance`）。
 */
function balanceSlot(holder: Address, slot: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [holder, slot]));
}

const ERC20_BALANCE_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

async function readBalance(client: PublicClient, token: Address, holder: Address): Promise<bigint> {
  return (await client.readContract({
    address: token,
    abi: ERC20_BALANCE_ABI,
    functionName: 'balanceOf',
    args: [holder],
  })) as bigint;
}

/**
 * 把 `holder` 的 `token` 餘額設成 `amount`，回傳成功的 slot。
 *
 * 逐一把 0..`maxSlot` 當成 mapping 的 slot 寫進去，回讀 `balanceOf` 確認。寫到錯的 slot 只會動到
 * 「別的 mapping 對這個 holder 的那一格」，無害；但**沒有回讀就宣稱成功**才是真正的問題。
 */
async function setBalance(
  client: PublicClient,
  token: Address,
  holder: Address,
  amount: bigint,
  maxSlot = 12n,
): Promise<bigint> {
  for (let slot = 0n; slot <= maxSlot; slot += 1n) {
    const key = balanceSlot(holder, slot);
    await rpc(client, 'anvil_setStorageAt', [token, key, toHex(amount, { size: 32 })]);
    if ((await readBalance(client, token, holder)) === amount) return slot;
  }
  throw new Error(
    `試過 slot 0..${maxSlot} 都寫不進 ${token} 的 balanceOf（回讀不是 ${amount}）：這個代幣的佈局不是 ` +
      'mapping(address=>uint256) 的常規位置，需要人工確認。停下，不做任何後續動作。',
  );
}

async function rpc(client: PublicClient, method: string, params: readonly unknown[]): Promise<unknown> {
  return client.request({ method: method as never, params: params as never });
}

function log(tag: string, message: string): void {
  console.log(`[${tag}] ${message}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rpcUrl = process.env.RPC_URL ?? '';
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|$)/.test(rpcUrl)) {
    // 這支腳本會直接改 storage —— 在任何不是本機 fork 的鏈上都是災難。
    throw new Error(`這支腳本只對本機 anvil 有效：RPC_URL 是 ${JSON.stringify(rpcUrl)}，不是 localhost`);
  }

  const client = createPublicClient({ transport: http(rpcUrl) });

  // ---- [1] 這個投組的帳戶與策略版本 ----
  const row = (
    await query<{ address: string; strategy_id: string; version: number; allocation: unknown }>(
      `select sa.address, p.strategy_id, p.version, v.allocation
         from portfolios p
         join smart_accounts sa on sa.portfolio_id = p.id
         join strategy_versions v on v.strategy_id = p.strategy_id and v.version = p.version
        where p.id = $1
        limit 1`,
      [args.portfolioId],
    )
  ).rows[0];
  if (row === undefined) throw new Error(`portfolio ${args.portfolioId} 沒有 smart account 或策略版本`);

  const account = row.address as Address;
  const assets = (row.allocation as { assets: { address: string; weightBps: number }[] }).assets;
  log('1', `portfolio ${args.portfolioId} → ${account}（strategy ${row.strategy_id} v${row.version}，${assets.length} 個資產）`);

  // ---- [2] 找出 numeraire ----
  const priceable = (
    await query<{ address: string; symbol: string; decimals: number; is_numeraire: boolean }>(
      'select address, symbol, decimals, is_numeraire from priceable_assets where enabled',
    )
  ).rows;
  const byAddress = new Map(priceable.map((asset) => [asset.address.toLowerCase(), asset]));
  const numeraire = priceable.find((asset) => asset.is_numeraire);
  if (numeraire === undefined) throw new Error('priceable_assets 沒有 numeraire（is_numeraire = true）');
  if (!NUMERAIRES.has(numeraire.symbol)) {
    log('2', `⚠ numeraire 是 ${numeraire.symbol}，不是 USDT —— 這支腳本假設 numeraire 的 1 單位 = 1 USD`);
  }
  const amount = parseUnits(String(args.usd), numeraire.decimals);
  log('2', `numeraire ${numeraire.symbol}（${numeraire.address}，${numeraire.decimals} decimals）→ 入金 ${args.usd}`);

  const missing = assets.filter((asset) => !byAddress.has(asset.address.toLowerCase()));
  for (const asset of missing) log('2', `⚠ 策略資產 ${asset.address} 不在 priceable_assets：它不會被定價，也不影響這次入金`);

  // numeraire **必須是策略資產**：規劃器走 hub 模式時，賣出收到的是 numeraire、買入付的也是 numeraire
  // （`rebalance-plan.ts` 的「目標權重裡沒有 numeraire → blocked」）。它不在 allocation 裡時，
  // 就算帳戶有 20,000 USDT，drift 還是 5000（持有但不在宇宙裡＝不計價、不能搬）。
  const hasNumeraire = assets.some((asset) => asset.address.toLowerCase() === numeraire.address.toLowerCase());
  if (!hasNumeraire) {
    throw new Error(
      `這個策略的 allocation 沒有 numeraire ${numeraire.symbol}（只有 ${assets
        .map((asset) => byAddress.get(asset.address.toLowerCase())?.symbol ?? asset.address.slice(0, 10))
        .join(' / ')}）：` +
        `入金 ${numeraire.symbol} 不會讓它變成可再平衡 —— 執行器只換 version.assets 裡的代幣，` +
        `hub 不是策略資產就收不了賣出的 ${numeraire.symbol}、也付不出買的 ${numeraire.symbol}。` +
        `先發一個新版本把 ${numeraire.symbol} 加進 allocation（或直接把策略資產轉進去）。`,
    );
  }

  // ---- [3] gas：直接給 BNB ----
  if (args.gasBnb > 0) {
    const wei = parseUnits(String(args.gasBnb), 18);
    if (args.dryRun) log('3', `（dry-run）會把 ${args.gasBnb} BNB 寫進 ${account}`);
    else {
      await rpc(client, 'anvil_setBalance', [account, toHex(wei)]);
      const after = await client.getBalance({ address: account });
      log('3', `BNB 餘額 ${after} wei（${args.gasBnb} BNB）${after === wei ? ' ✓' : ' ✗ 回讀不符'}`);
    }
  }

  // ---- [4] numeraire：探測 slot 直到回讀對得上 ----
  if (args.dryRun) {
    log('4', `（dry-run）會把 ${amount} 單位的 ${numeraire.symbol} 寫進去（slot 0..12 逐一探測）`);
  } else {
    const token = numeraire.address as Address;
    const before = await readBalance(client, token, account);
    const slot = await setBalance(client, token, account, amount);
    const after = await readBalance(client, token, account);
    log('4', `${numeraire.symbol} 餘額 ${before} → ${after} ✓（mapping 在 slot ${slot}）`);
  }

  log('i', `完成。下一步：看 https://…/portfolios/${args.portfolioId} 按 Re-analyse，或跑一輪排程器`);
}

await main();
await closePool().catch(() => undefined);
