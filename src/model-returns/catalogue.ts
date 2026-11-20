import assets from './assets.json' with { type: 'json' };
import { testnetAssets } from '../testnet-profile.js';
export const MODEL_ASSETS: readonly { symbol: string; address: string; pair: string }[] = assets;

/** Addresses are authoritative: optional allocation display symbols cannot impersonate a covered asset. */
export function modelSymbol(address: string, chainId: number): string | null {
  if (chainId === 97) {
    const symbol = testnetAssets().find(asset => asset.address.toLowerCase() === address.toLowerCase())?.symbol.toUpperCase();
    return MODEL_ASSETS.find(asset => asset.symbol === symbol)?.symbol ?? null;
  }
  return MODEL_ASSETS.find(asset => asset.address.toLowerCase() === address.toLowerCase())?.symbol ?? null;
}
