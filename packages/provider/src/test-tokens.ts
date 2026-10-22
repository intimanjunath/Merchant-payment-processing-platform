/**
 * Test payment-method tokens (spec §6). These stand in for a provider's
 * tokenized cards; the platform never sees card numbers.
 */
export const TEST_TOKENS = {
  pm_card_visa: { brand: 'visa', last4: '4242' },
  pm_card_declined: { brand: 'visa', last4: '0002' },
  pm_timeout: { brand: 'mastercard', last4: '4444' },
  pm_lost_response: { brand: 'amex', last4: '0005' },
} as const;

export type TestToken = keyof typeof TEST_TOKENS;

export function isTestToken(token: string): token is TestToken {
  return Object.hasOwn(TEST_TOKENS, token);
}
