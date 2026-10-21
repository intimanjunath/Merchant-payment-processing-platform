import { Writable } from 'node:stream';

import type { NestExpressApplication } from '@nestjs/platform-express';
import { createPool, migrate, seed } from '@payments/db';
import { createLogger, createMetricsRegistry, type Registry } from '@payments/observability';
import type { Pool } from 'pg';

import { createApp } from '../../apps/api/src/app';
import { loadConfig } from '../../apps/api/src/config/config';
import { testDatabaseUrl } from './test-db';

export interface TestApi {
  app: NestExpressApplication;
  logs: Record<string, unknown>[];
  metrics: Registry;
  /** The app's own pool, for checking that nothing is left checked out. */
  pool: Pool;
}

export interface TestApiOptions {
  databaseUrl?: string;
  readinessTimeoutMs?: number;
  applicationName?: string;
  /** LOGIN_THROTTLE_* overrides; the defaults match production (15 min, 5 per email, 50 per IP). */
  throttle?: { windowSeconds?: number; maxPerEmail?: number; maxPerIp?: number };
}

const TEST_SECRET = 'test-only-secret-0123456789abcdef';

/** Token settings the test API signs with, for crafting tokens in tests. */
export const TEST_JWT = {
  secret: TEST_SECRET,
  issuer: 'payment-platform',
  audience: 'payment-platform-api',
};
export const TEST_CSRF_SECRET = TEST_SECRET;

/** The development merchants from packages/db/seeds/001_merchants.sql. */
export const SEEDED_MERCHANTS = {
  acme: { email: 'merchant1@example.test', password: 'acme-coffee-dev', name: 'Acme Coffee' },
  bicycle: {
    email: 'merchant2@example.test',
    password: 'blue-bicycle-dev',
    name: 'Blue Bicycle Shop',
  },
};

/** Applies all migrations (and optionally the seeds) to the test database. Safe to repeat. */
export async function migrateTestDatabase(options: { seed?: boolean } = {}): Promise<void> {
  const pool = createPool(testDatabaseUrl(), { applicationName: 'test-migrate', max: 1 });
  try {
    await migrate(pool);
    if (options.seed) await seed(pool);
  } finally {
    await pool.end();
  }
}

/**
 * Clears failed-login counters so one suite's deliberate failures can't lock
 * out the seeded merchants for the next.
 */
export async function clearLoginAttempts(): Promise<void> {
  const pool = createPool(testDatabaseUrl(), { applicationName: 'test-reset', max: 1 });
  try {
    await pool.query('DELETE FROM login_attempts');
  } finally {
    await pool.end();
  }
}

/** Builds the API against the test database (or `databaseUrl`) and captures its logs. */
export async function startTestApi(options: TestApiOptions = {}): Promise<TestApi> {
  const databaseUrl = options.databaseUrl ?? testDatabaseUrl();
  const config = loadConfig({
    DATABASE_URL: databaseUrl,
    JWT_SECRET: TEST_SECRET,
    CSRF_SECRET: TEST_SECRET,
    CURSOR_SECRET: TEST_SECRET,
    LOG_LEVEL: 'debug',
    LOGIN_THROTTLE_WINDOW_SECONDS: options.throttle?.windowSeconds?.toString(),
    LOGIN_THROTTLE_MAX_PER_EMAIL: options.throttle?.maxPerEmail?.toString(),
    LOGIN_THROTTLE_MAX_PER_IP: options.throttle?.maxPerIp?.toString(),
  });
  const logs: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, done) {
      logs.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      done();
    },
  });
  const logger = createLogger({ service: 'api', level: 'debug', destination });
  const pool = createPool(databaseUrl, {
    applicationName: options.applicationName ?? 'api-test',
    max: 2,
    onIdleClientError: () => undefined,
  });
  const metrics = createMetricsRegistry('api');
  const app = await createApp({
    config,
    logger,
    pool,
    metrics,
    ...(options.readinessTimeoutMs === undefined
      ? {}
      : { readinessTimeoutMs: options.readinessTimeoutMs }),
  });
  await app.init();
  return { app, logs, metrics, pool };
}
