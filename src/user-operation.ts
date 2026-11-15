import type { Hex } from 'viem';
import type { UserOperation } from 'viem/account-abstraction';

/** prepareUserOperation supplies an estimation signature; viem sends any supplied signature verbatim. */
export async function signPreparedOperation(operation: UserOperation<'0.7'>,
  sign: (operation: UserOperation<'0.7'>) => Promise<Hex>): Promise<UserOperation<'0.7'>> {
  return { ...operation, signature: await sign(operation) };
}
