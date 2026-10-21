import { Writable } from 'node:stream';

import type { NestExpressApplication } from '@nestjs/platform-express';
import { createPool, migrate } from '@payments/db';
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
}

const TEST_SECRET = 'test-only-secret-0123456789abcdef';

/** Applies all migrations to the test database. Safe to call from every suite. */
export async function migrateTestDatabase(): Promise<void> {
  const pool = createPool(testDatabaseUrl(), { applicationName: 'test-migrate', max: 1 });
  try {
    await migrate(pool);
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
