import { readStateSnapshot, type StateSnapshot } from '@payments/db';
import { Gauge, type Logger, type Registry } from '@payments/observability';
import { JOB_TYPES, PAYMENT_STATES } from '@payments/payments';
import type { Pool } from 'pg';

// Within one scrape every gauge asks for the snapshot; this keeps it to one query.
const SNAPSHOT_REUSE_MS = 1_000;

/**
 * The current-state gauges (spec §7.2), computed only here, in the worker, so
 * that several API instances never double-count them. Each scrape reads the
 * database once. If the read fails, the gauges keep their last values and a
 * warning is logged; the scrape itself still succeeds.
 */
export function registerStateCollector(registry: Registry, pool: Pool, logger: Logger): void {
  let cached: { at: number; snapshot: Promise<StateSnapshot> } | undefined;
  let last: StateSnapshot = {
    paymentsByState: {},
    jobsDue: {},
    jobsLagSeconds: {},
    jobsPaused: {},
    oldestUnresolvedSeconds: 0,
  };

  const snapshot = (): Promise<StateSnapshot> => {
    const now = Date.now();
    if (!cached || now - cached.at > SNAPSHOT_REUSE_MS) {
      cached = {
        at: now,
        snapshot: readStateSnapshot(pool).then(
          (fresh) => (last = fresh),
          (error: unknown) => {
            logger.warn(
              { event: 'metrics.collect_failed', err: error },
              'Could not read state for metrics',
            );
            return last;
          },
        ),
      };
    }
    return cached.snapshot;
  };

  /** Sets every known label value, so a state or type with nothing in it reads 0 rather than vanishing. */
  const fill = (
    gauge: Gauge<string>,
    label: string,
    values: readonly string[],
    counts: Record<string, number>,
  ) => {
    for (const value of values) gauge.set({ [label]: value }, counts[value] ?? 0);
  };

  new Gauge({
    name: 'payments_by_state',
    help: 'Payments in each state.',
    labelNames: ['state'],
    registers: [registry],
    async collect() {
      fill(this, 'state', PAYMENT_STATES, (await snapshot()).paymentsByState);
    },
  });
  new Gauge({
    name: 'jobs_due',
    help: 'Jobs waiting to run now: queued and due, or running with an expired lease (queue depth).',
    labelNames: ['type'],
    registers: [registry],
    async collect() {
      fill(this, 'type', JOB_TYPES, (await snapshot()).jobsDue);
    },
  });
  new Gauge({
    name: 'jobs_lag_seconds',
    help: 'How long the oldest due job of each type has been waiting.',
    labelNames: ['type'],
    registers: [registry],
    async collect() {
      fill(this, 'type', JOB_TYPES, (await snapshot()).jobsLagSeconds);
    },
  });
  new Gauge({
    name: 'jobs_paused',
    help: 'Paused jobs needing review (the dead-letter backlog).',
    labelNames: ['type'],
    registers: [registry],
    async collect() {
      fill(this, 'type', JOB_TYPES, (await snapshot()).jobsPaused);
    },
  });
  new Gauge({
    name: 'operations_unresolved_oldest_age_seconds',
    help: 'Age of the oldest reserved, awaiting or paused operation; 0 when there is none.',
    registers: [registry],
    async collect() {
      this.set((await snapshot()).oldestUnresolvedSeconds);
    },
  });
}
