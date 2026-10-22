import type { Logger } from '@payments/observability';
import { ProviderTimeoutError, ProviderUnavailableError } from '@payments/provider';

/** The outcome of a call that may or may not have reached the provider. */
export interface ProviderFailure {
  failure: 'provider_timeout' | 'provider_unavailable';
}

export function isProviderFailure(value: object): value is ProviderFailure {
  return 'failure' in value;
}

/**
 * Runs one provider call. No transaction is open and no row is locked while
 * it runs. Timeouts and transport failures become "outcome unknown"; any
 * other error propagates, and the leased job lets the worker recover after
 * the lease expires. Logs the call's outcome and duration, never the token.
 */
export async function callProvider<T extends { outcome: string }>(
  logger: Logger,
  ids: { paymentId: string; operationId?: string; action: string; call: string },
  call: () => Promise<T>,
): Promise<T | ProviderFailure> {
  const started = performance.now();
  const durationMs = () => Math.round(performance.now() - started);
  try {
    const result = await call();
    logger.debug(
      {
        event: 'provider.call.completed',
        ...ids,
        outcome: result.outcome,
        durationMs: durationMs(),
      },
      'Provider call completed',
    );
    return result;
  } catch (error) {
    const failure =
      error instanceof ProviderTimeoutError
        ? 'provider_timeout'
        : error instanceof ProviderUnavailableError
          ? 'provider_unavailable'
          : undefined;
    if (!failure) throw error;
    logger.warn(
      { event: 'provider.call.completed', ...ids, outcome: failure, durationMs: durationMs() },
      'Provider call failed; outcome unknown',
    );
    return { failure };
  }
}
