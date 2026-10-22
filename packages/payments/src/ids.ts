const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The one spelling of a payment ID used for lookups, scopes and hashes, or
 * undefined if it is not a UUID (treated as not found). PostgreSQL reads every
 * spelling of a UUID as the same value, so keys built from it must agree.
 */
export function canonicalPaymentId(raw: string): string | undefined {
  return UUID.test(raw) ? raw.toLowerCase() : undefined;
}
