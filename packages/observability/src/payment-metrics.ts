import { Counter, Histogram, type Registry } from '@prometheus-io/client';

/**
 * Domain and job metrics (spec §7.2), recorded by the process that does the
 * work. Every label has a small, fixed set of values: never a payment,
 * merchant or operation ID, nor a reference.
 */
export interface PaymentMetrics {
  /** Committed state changes; creation is counted from `none` to `pending`. */
  transitions: Counter<'from_state' | 'to_state'>;
  idempotencyReplays: Counter<'action'>;
  idempotencyConflicts: Counter<'action'>;
  /** One per provider call: `outcome` is how the call went, not the business answer. */
  providerRequests: Counter<'operation' | 'outcome'>;
  providerDuration: Histogram<'operation'>;
  jobRuns: Counter<'type' | 'result'>;
}

export function createPaymentMetrics(registry: Registry): PaymentMetrics {
  const registers = [registry];
  return {
    transitions: new Counter({
      name: 'payment_transitions_total',
      help: 'Committed payment state transitions; creation counts from "none" to "pending".',
      labelNames: ['from_state', 'to_state'] as const,
      registers,
    }),
    idempotencyReplays: new Counter({
      name: 'idempotency_replays_total',
      help: 'Requests answered from an earlier operation with the same key and input.',
      labelNames: ['action'] as const,
      registers,
    }),
    idempotencyConflicts: new Counter({
      name: 'idempotency_conflicts_total',
      help: 'Requests refused because their key was used with a different input.',
      labelNames: ['action'] as const,
      registers,
    }),
    providerRequests: new Counter({
      name: 'provider_requests_total',
      help: 'Provider calls by operation and how the call went (succeeded, rejected, timeout, unavailable).',
      labelNames: ['operation', 'outcome'] as const,
      registers,
    }),
    providerDuration: new Histogram({
      name: 'provider_request_duration_seconds',
      help: 'Provider call latency in seconds, by operation.',
      labelNames: ['operation'] as const,
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers,
    }),
    jobRuns: new Counter({
      name: 'job_runs_total',
      help: 'Job runs by type and result (completed, rescheduled, retried, paused, lease_lost, version_conflict, failed).',
      labelNames: ['type', 'result'] as const,
      registers,
    }),
  };
}
