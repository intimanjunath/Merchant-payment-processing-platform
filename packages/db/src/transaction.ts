import type { Pool, PoolClient } from 'pg';

/**
 * Runs `work` inside BEGIN/COMMIT on one connection and rolls back if it throws.
 * If the rollback itself fails the connection is in an unknown state, so it is
 * destroyed instead of going back to the pool.
 */
export async function withTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let brokenConnection: Error | undefined;
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      brokenConnection =
        rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
    }
    throw error;
  } finally {
    client.release(brokenConnection);
  }
}
