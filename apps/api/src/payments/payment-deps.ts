import { hostname } from 'node:os';

import { createPaymentMetrics, type Logger, type Registry } from '@payments/observability';
import type { PaymentDeps } from '@payments/payments';
import { createFakeProvider, type PaymentProvider } from '@payments/provider';
import type { Pool } from 'pg';

import type { ApiConfig } from '../config/config';

export interface PaymentDepsInput {
  config: ApiConfig;
  logger: Logger;
  pool: Pool;
  metrics: Registry;
  /** The payment provider; defaults to the durable fake on the same database. */
  provider?: PaymentProvider | undefined;
  /** Names the process in job lease owners: the API itself, or the development payment seed. */
  role?: 'api' | 'seed';
}

/**
 * What the payments package needs, built once from configuration. The API
 * and the development payment seed share it, so seeded payments go through
 * exactly the same reservation, provider call and finalization.
 */
export function createPaymentDeps(input: PaymentDepsInput): PaymentDeps {
  const { config } = input;
  return {
    pool: input.pool,
    logger: input.logger,
    provider:
      input.provider ??
      createFakeProvider(input.pool, {
        timeoutMs: config.providerTimeoutMs,
        settlementDelayMs: config.settlementDelayMs,
      }),
    // Audit rows only know api and worker; the seed writes through the API's path.
    source: 'api',
    leaseOwner: `${input.role ?? 'api'}:${hostname()}:${String(process.pid)}`,
    leaseSeconds: config.jobs.leaseSeconds,
    reviewDeadlineSeconds: config.jobs.reviewDeadlineSeconds,
    recoveryDelayMs: config.workerPollIntervalMs,
    settlementPollMs: config.workerPollIntervalMs,
    metrics: createPaymentMetrics(input.metrics),
  };
}
