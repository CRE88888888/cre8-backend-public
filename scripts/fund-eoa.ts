/**
 * 在 anvil fork 上補 BNB 給任意位址（通常是測試者的 MetaMask 帳戶）。
 *
 * ## 為什麼需要這支
 * fork 上的 gas 只存在於「本地狀態」：dump 裡有的帳戶（我們的合約、anvil 內建帳戶）不需要上游；
 * 但**測試者的 MetaMask 位址不在 dump 裡**，讀寫都要回源查詢。而上游（publicnode）的歷史狀態
 * 窗口只有約 75 分鐘 —— 過了之後任何新位址的讀寫都會 403，症狀是錢包說「沒有 gas coin」。
 *
 * 實測結論：
 *   * fork **年輕**（剛 refresh）時：`anvil_setBalance` 有效，任何位址都能補。
 *   * fork **過期**後：連 `anvil_setBalance` 的讀回都會 403 —— 那時只能先跑 `refresh-anvil.sh`。
 *
 * 所以正確順序是「先 refresh，再補幣」。
 *
 * 用法：
 *   bun run scripts/fund-eoa.ts --address 0xabc… [--address 0xdef…] [--bnb 10]
 */
import { createPublicClient, http, parseEther } from 'viem';
import type { Address } from 'viem';

const ANVIL_RPC = process.env.ANVIL_RPC_URL ?? process.env.RPC_URL ?? 'http://127.0.0.1:8545';

function flags(name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] === `--${name}`) {
      const value = process.argv[i + 1];
      if (value !== undefined) out.push(value);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const addresses = flags('address');
  if (addresses.length === 0) throw new Error('至少要一個 --address 0x…');
  const bnb = flags('bnb')[0] ?? '10';
  const value = parseEther(bnb);

  const client = createPublicClient({ transport: http(ANVIL_RPC) });

  for (const raw of addresses) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) throw new Error(`不是地址：${raw}`);
    const address = raw as Address;
    // `anvil_setBalance` 直接寫本地狀態；fork 年輕時連「dump 裡沒有的位址」也能寫。
    await client.request({ method: 'anvil_setBalance' as never, params: [address, `0x${value.toString(16)}`] as never });
    const balance = await client.getBalance({ address });
    const ok = balance === value;
    console.log(`  ${address}  ${Number(balance) / 1e18} BNB  ${ok ? '✓' : '✗ 回讀不符'}`);
    if (!ok) {
      throw new Error(
        '回讀不符：fork 可能已經過期（上游 archive 窗口約 75 分鐘）。先跑 refresh-anvil.sh 再試 —— ' +
          '寫入看起來成功但讀不到，就是這個症狀。',
      );
    }
  }
}

await main();
