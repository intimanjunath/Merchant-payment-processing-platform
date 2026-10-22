import { ConfigError, type Env, EnvReader } from '@payments/config';
import type { LogLevel } from '@payments/observability';

export { ConfigError };

export interface WorkerConfig {
  databaseUrl: string;
  healthPort: number;
  logLevel: LogLevel;
  providerTimeoutMs: number;
  settlementDelayMs: number;
  pollIntervalMs: number;
  concurrency: number;
  heartbeatIntervalMs: number;
  shutdownGraceMs: number;
  jobs: {
    leaseSeconds: number;
    maxRetries: number;
    retryBaseMs: number;
    reviewDeadlineSeconds: number;
  };
}

/** Reads the worker's settings (spec §8), reporting every problem at once. */
export function loadWorkerConfig(env: Env = process.env): WorkerConfig {
  const problems: string[] = [];
  const read = new EnvReader(env, problems);

  const config: WorkerConfig = {
    databaseUrl: read.url('DATABASE_URL'),
    healthPort: read.integer('WORKER_HEALTH_PORT', { fallback: 3001, min: 1, max: 65_535 }),
    logLevel: read.logLevel('LOG_LEVEL', 'info'),
    providerTimeoutMs: read.integer('PROVIDER_TIMEOUT_MS', { fallback: 5_000, min: 1 }),
    settlementDelayMs: read.integer('SETTLEMENT_DELAY_MS', { fallback: 10_000, min: 0 }),
    pollIntervalMs: read.integer('WORKER_POLL_INTERVAL_MS', { fallback: 5_000, min: 1 }),
    concurrency: read.integer('WORKER_CONCURRENCY', { fallback: 1, min: 1, max: 64 }),
    heartbeatIntervalMs: read.integer('WORKER_HEARTBEAT_INTERVAL_MS', { fallback: 10_000, min: 1 }),
    shutdownGraceMs: read.integer('WORKER_SHUTDOWN_GRACE_MS', { fallback: 15_000, min: 0 }),
    jobs: {
      leaseSeconds: read.integer('JOB_LEASE_SECONDS', { fallback: 30, min: 1 }),
      maxRetries: read.integer('JOB_MAX_RETRIES', { fallback: 3, min: 0 }),
      retryBaseMs: read.integer('JOB_RETRY_BASE_MS', { fallback: 2_000, min: 1 }),
      reviewDeadlineSeconds: read.integer('REVIEW_DEADLINE_SECONDS', { fallback: 1_800, min: 1 }),
    },
  };

  // A lease must outlast one recovery attempt: a lookup plus a re-send (spec §5.5).
  if (config.jobs.leaseSeconds * 1000 <= 2 * config.providerTimeoutMs) {
    problems.push('JOB_LEASE_SECONDS must be longer than two PROVIDER_TIMEOUT_MS periods');
  }
  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}
