import type { Pool, PoolClient } from 'pg';

import { withTransaction } from '../transaction';

/** Hashed subjects (never raw emails or IPs) and the fixed window they fall in. */
export interface ThrottleKey {
  emailHash: string;
  ipHash: string;
  windowStart: Date;
}

// Advisory lock classes for the two-key form, which never overlaps the
// single-key lock the migration runner takes.
const EMAIL_LOCK_CLASS = 1001;
const IP_LOCK_CLASS = 1002;

/**
 * Every transaction that touches login_attempts first locks its email subject,
 * then its IP subject, and only then reads or writes their rows. With one lock
 * of each kind, always in that order, no two transactions can wait on each
 * other in a cycle, whatever order a statement visits rows in. The locks are
 * released at commit; a hash collision only serializes two unrelated subjects.
 */
async function lockSubjects(client: PoolClient, key: ThrottleKey): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
    EMAIL_LOCK_CLASS,
    key.emailHash,
  ]);
  await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [IP_LOCK_CLASS, key.ipHash]);
}

/**
 * Counts one attempt for the email and the IP before the password is checked,
 * and returns the counts including it. Increments happen under the subject
 * locks, so concurrent attempts each see a distinct count and a burst cannot
 * slip under the limit. Older windows for the same subjects are removed so the
 * table stays small.
 */
export async function countAttempt(
  pool: Pool,
  key: ThrottleKey,
): Promise<{ email: number; ip: number }> {
  return withTransaction(pool, async (client) => {
    await lockSubjects(client, key);
    const result = await client.query<{ scope: 'email' | 'ip'; failures: number }>(
      `WITH cleared AS (
         DELETE FROM login_attempts
          WHERE window_start < $3
            AND ((scope = 'email' AND subject_hash = $1) OR (scope = 'ip' AND subject_hash = $2))
       )
       INSERT INTO login_attempts (scope, subject_hash, window_start, failures)
       VALUES ('email', $1, $3, 1), ('ip', $2, $3, 1)
       ON CONFLICT (scope, subject_hash, window_start)
       DO UPDATE SET failures = login_attempts.failures + 1
       RETURNING scope, failures`,
      [key.emailHash, key.ipHash, key.windowStart],
    );
    const counts = { email: 0, ip: 0 };
    for (const row of result.rows) counts[row.scope] = row.failures;
    return counts;
  });
}

/**
 * After a successful login, the account's own failures no longer count, and
 * the attempt counted for the IP is taken back.
 */
export async function forgiveAttempt(pool: Pool, key: ThrottleKey): Promise<void> {
  await withTransaction(pool, async (client) => {
    await lockSubjects(client, key);
    await client.query(`DELETE FROM login_attempts WHERE scope = 'email' AND subject_hash = $1`, [
      key.emailHash,
    ]);
    await client.query(
      `UPDATE login_attempts
          SET failures = failures - 1
        WHERE scope = 'ip' AND subject_hash = $1 AND window_start = $2 AND failures > 0`,
      [key.ipHash, key.windowStart],
    );
  });
}
