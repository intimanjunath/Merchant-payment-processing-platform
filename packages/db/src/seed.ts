import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';

import { SEEDS_DIR } from './paths';
import { withTransaction } from './transaction';

/**
 * Runs every seed file in name order inside one transaction. Seed files must be
 * safe to re-run (INSERT ... ON CONFLICT DO NOTHING), so seeding twice is a no-op.
 */
export async function seed(pool: Pool, dir = SEEDS_DIR): Promise<string[]> {
  const files = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
  await withTransaction(pool, async (client) => {
    for (const name of files) {
      await client.query(await readFile(path.join(dir, name), 'utf8'));
    }
  });
  return files;
}
