import { randomUUID } from 'node:crypto';

import { createPool, migrate, requireDatabaseUrl, seed } from '@payments/db';
import { Client } from 'pg';

/** Tests only ever touch the disposable test database, never DATABASE_URL. */
export function testDatabaseUrl(): string {
  return requireDatabaseUrl('TEST_DATABASE_URL');
}

/**
 * A database of its own inside test-db, migrated (and optionally seeded), for
 * suites that claim "any due job" and must not see other suites' leftovers.
 */
export async function createScratchDatabase(
  options: { seed?: boolean } = {},
): Promise<{ url: string; drop: () => Promise<void> }> {
  const name = `scratch_${randomUUID().replaceAll('-', '')}`;
  const admin = new Client({ connectionString: testDatabaseUrl() });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = new URL(testDatabaseUrl());
  url.pathname = `/${name}`;
  const pool = createPool(url.toString(), { applicationName: 'scratch-setup', max: 1 });
  try {
    await migrate(pool);
    if (options.seed) await seed(pool);
  } finally {
    await pool.end();
  }

  return {
    url: url.toString(),
    drop: async () => {
      const client = new Client({ connectionString: testDatabaseUrl() });
      await client.connect();
      try {
        await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await client.end();
      }
    },
  };
}
