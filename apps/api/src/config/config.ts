import { ConfigError, type Env, EnvReader } from '@payments/config';
import type { LogLevel } from '@payments/observability';

export { ConfigError };

export interface ApiConfig {
  production: boolean;
  databaseUrl: string;
  port: number;
  logLevel: LogLevel;
  jwt: { secret: string; issuer: string; audience: string };
  sessionTtlSeconds: number;
  csrfSecret: string;
  cursorSecret: string;
  cookieSecure: boolean;
  allowedOrigins: string[];
  trustProxy: boolean;
  loginThrottle: { windowSeconds: number; maxPerEmail: number; maxPerIp: number };
  providerTimeoutMs: number;
  settlementDelayMs: number;
  /** Delay of the first recovery after a timeout and of the first settlement check. */
  workerPollIntervalMs: number;
  jobs: {
    leaseSeconds: number;
    maxRetries: number;
    retryBaseMs: number;
    reviewDeadlineSeconds: number;
  };
}

/**
 * Reads the API's settings from the environment (spec §8). Every problem is
 * collected before failing, so one start-up attempt shows them all. Error
 * messages name variables but never echo their values.
 */
export function loadConfig(env: Env = process.env): ApiConfig {
  const problems: string[] = [];
  const read = new EnvReader(env, problems);

  const production = env.NODE_ENV === 'production';
  const config: ApiConfig = {
    production,
    databaseUrl: read.url('DATABASE_URL'),
    port: read.integer('API_PORT', { fallback: 3000, min: 1, max: 65_535 }),
    logLevel: read.logLevel('LOG_LEVEL', 'info'),
    jwt: {
      secret: read.secret('JWT_SECRET'),
      issuer: read.string('JWT_ISSUER', 'payment-platform'),
      audience: read.string('JWT_AUDIENCE', 'payment-platform-api'),
    },
    sessionTtlSeconds: read.integer('SESSION_TTL_SECONDS', { fallback: 28_800, min: 60 }),
    csrfSecret: read.secret('CSRF_SECRET'),
    cursorSecret: read.secret('CURSOR_SECRET'),
    cookieSecure: read.boolean('COOKIE_SECURE', false),
    allowedOrigins: read.list('ALLOWED_ORIGINS', ['http://localhost:5173']),
    trustProxy: read.boolean('TRUST_PROXY', false),
    loginThrottle: {
      windowSeconds: read.integer('LOGIN_THROTTLE_WINDOW_SECONDS', { fallback: 900, min: 1 }),
      maxPerEmail: read.integer('LOGIN_THROTTLE_MAX_PER_EMAIL', { fallback: 5, min: 1 }),
      maxPerIp: read.integer('LOGIN_THROTTLE_MAX_PER_IP', { fallback: 50, min: 1 }),
    },
    providerTimeoutMs: read.integer('PROVIDER_TIMEOUT_MS', { fallback: 5_000, min: 1 }),
    settlementDelayMs: read.integer('SETTLEMENT_DELAY_MS', { fallback: 10_000, min: 0 }),
    workerPollIntervalMs: read.integer('WORKER_POLL_INTERVAL_MS', { fallback: 5_000, min: 1 }),
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
  if (production && !config.cookieSecure) {
    problems.push('COOKIE_SECURE must be true when NODE_ENV is production');
  }

  if (problems.length > 0) {
    throw new ConfigError(problems);
  }
  return config;
}
