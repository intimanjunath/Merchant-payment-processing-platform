import type { Logger, PaymentMetrics } from '@payments/observability';
import { ProviderTimeoutError, ProviderUnavailableError } from '@payments/provider';

import { metricsOf } from './metrics';

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
  deps: { logger: Logger; metrics?: PaymentMetrics | undefined },
  ids: { paymentId: string; operationId?: string; action: string; call: string },
  call: () => Promise<T>,
): Promise<T | ProviderFailure> {
  const { logger } = deps;
  const metrics = metricsOf(deps);
  const started = performance.now();
  const durationMs = () => Math.round(performance.now() - started);
  // The outcome label says how the call went; a "not received" or "pending" answer is a successful call.
  const record = (outcome: 'succeeded' | 'rejected' | 'timeout' | 'unavailable') => {
    metrics.providerRequests.inc({ operation: ids.call, outcome });
    metrics.providerDuration.observe({ operation: ids.call }, (performance.now() - started) / 1000);
  };
  try {
    const result = await call();
    record(result.outcome === 'rejected' ? 'rejected' : 'succeeded');
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
    record(failure === 'provider_timeout' ? 'timeout' : 'unavailable');
    logger.warn(
      { event: 'provider.call.completed', ...ids, outcome: failure, durationMs: durationMs() },
      'Provider call failed; outcome unknown',
    );
    return { failure };
  }
}
