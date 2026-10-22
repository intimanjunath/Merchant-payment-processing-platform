export type ProviderCallKind = 'authorize' | 'capture' | 'refund';

export type ProviderResult =
  { outcome: 'succeeded'; chargeId: string } | { outcome: 'rejected'; code: string };

export type LookupResult = ProviderResult | { outcome: 'not_received' };

/**
 * What the payment core needs from a provider (spec §6). Every call carries a
 * provider key; repeating a key returns the stored outcome without a new
 * effect. Timeouts throw ProviderTimeoutError and other transport failures
 * throw ProviderUnavailableError; callers treat both as "outcome unknown".
 */
export interface PaymentProvider {
  describePaymentMethod(token: string): { brand: string; last4: string } | null;
  authorize(req: {
    providerKey: string;
    token: string;
    amountCents: number;
  }): Promise<ProviderResult>;
  capture(req: {
    providerKey: string;
    chargeId: string;
    amountCents: number;
  }): Promise<ProviderResult>;
  refund(req: {
    providerKey: string;
    chargeId: string;
    amountCents: number;
  }): Promise<ProviderResult>;
  lookup(req: { kind: ProviderCallKind; providerKey: string }): Promise<LookupResult>;
  getSettlement(chargeId: string): Promise<{ status: 'pending' | 'available' }>;
}

export class ProviderTimeoutError extends Error {
  constructor() {
    super('The provider did not answer in time.');
    this.name = 'ProviderTimeoutError';
  }
}

export class ProviderUnavailableError extends Error {
  constructor(cause: unknown) {
    super('The provider could not be reached.', { cause });
    this.name = 'ProviderUnavailableError';
  }
}
