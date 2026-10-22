/**
 * Per-merchant records kept in sessionStorage (pending actions and their
 * idempotency keys, from step 18). Keys are scoped by merchant so two
 * merchants signing in on one browser never see each other's work, and
 * signing out removes everything the signed-out merchant left behind.
 */
const PREFIX = 'pp:';

export function recordKey(merchantId: string, name: string): string {
  return `${PREFIX}${merchantId}:${name}`;
}

/** Removes every record belonging to this merchant, and nothing else. */
export function clearMerchantRecords(storage: Storage, merchantId: string): void {
  const prefix = `${PREFIX}${merchantId}:`;
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key?.startsWith(prefix)) keys.push(key);
  }
  for (const key of keys) storage.removeItem(key);
}
