import { createHash } from 'node:crypto';

import { countAttempt, createPool, forgiveAttempt, type ThrottleKey } from '@payments/db';
import type { Pool } from 'pg';

import { clearLoginAttempts, migrateTestDatabase } from '../helpers/api';
import { testDatabaseUrl } from '../helpers/test-db';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const WINDOW_MS = 60_000;

describe('login attempt counters under concurrency', () => {
  let pool: Pool;

  beforeAll(async () => {
    await migrateTestDatabase();
    pool = createPool(testDatabaseUrl(), { applicationName: 'throttle-race', max: 20 });
  });

  beforeEach(async () => {
    await clearLoginAttempts();
  });

  afterAll(async () => {
    await pool.end();
    await clearLoginAttempts();
  });

  const keyAt = (windowStart: number): ThrottleKey => ({
    emailHash: hash('race@example.test'),
    ipHash: hash('203.0.113.7'),
    windowStart: new Date(windowStart),
  });

  /** One login: count the attempt, and on success take it back (the reset path). */
  async function login(key: ThrottleKey, succeeds: boolean): Promise<void> {
    await countAttempt(pool, key);
    if (succeeds) await forgiveAttempt(pool, key);
  }

  it('overlaps successful-login resets with new attempts without deadlocking', async () => {
    const key = keyAt(Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS);
    let failures = 0;

    for (let round = 0; round < 10; round += 1) {
      const outcomes = Array.from({ length: 20 }, (_, i) => i % 2 === 0);
      failures += outcomes.filter((succeeds) => !succeeds).length;
      await Promise.all(outcomes.map((succeeds) => login(key, succeeds)));
    }

    // Every success took back exactly its own attempt, so only failures remain for the IP.
    const ip = await pool.query<{ failures: number }>(
      `SELECT failures FROM login_attempts WHERE scope = 'ip' AND subject_hash = $1`,
      [key.ipHash],
    );
    expect(ip.rows).toEqual([{ failures }]);
  });

  it('cleans up older windows while other attempts and resets run', async () => {
    const start = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS;

    for (let round = 0; round < 10; round += 1) {
      // Attempts straddle a window boundary, so some delete the rows others are updating.
      const calls = Array.from({ length: 20 }, (_, i) =>
        login(keyAt(start + (round + (i % 2)) * WINDOW_MS), i % 3 === 0),
      );
      await Promise.all(calls);
    }

    const windows = await pool.query<{ scope: string }>(
      `SELECT scope FROM login_attempts WHERE subject_hash = ANY($1) AND window_start < $2`,
      [[keyAt(0).emailHash, keyAt(0).ipHash], new Date(start + 9 * WINDOW_MS)],
    );
    expect(windows.rows).toEqual([]);
  });
});
