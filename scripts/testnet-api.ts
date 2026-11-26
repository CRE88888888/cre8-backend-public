import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';
import type { LookupAddress } from 'node:dns';

/** Trust only the website service's exact private IPs, never an entire Railway CIDR. */
export async function websiteProxyIps(host: string, resolve: (host: string, options: { all: true }) => Promise<LookupAddress[]> = lookup): Promise<string> {
  if (!/^[a-z0-9-]+\.railway\.internal$/.test(host)) throw new Error('invalid website proxy host');
  try {
    const addresses = await resolve(host, { all: true });
    if (!addresses.length || addresses.some(({ address }) => !isIP(address))) throw new Error();
    return [...new Set(addresses.map(({ address }) => address))].join(',');
  } catch { throw new Error('website proxy DNS unavailable'); }
}

async function main() {
  if (process.env.CHAIN_ID !== '97') throw new Error('testnet API requires chain 97');
  if (process.env.WEBSITE_PROXY_HOST) {
    process.env.RATE_LIMIT_TRUSTED_PROXY_IPS = await websiteProxyIps(process.env.WEBSITE_PROXY_HOST);
  }
  await import('../src/index.js');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('[testnet-api] startup failed; check chain and proxy DNS'); process.exitCode = 1; });
}
