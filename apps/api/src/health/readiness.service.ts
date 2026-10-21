import { Inject, Injectable } from '@nestjs/common';
import { migrationStatus } from '@payments/db';
import type { Logger } from '@payments/observability';
import type { Pool, PoolClient } from 'pg';

import { DB_POOL, LOGGER, READINESS_TIMEOUT_MS } from '../tokens';

export type CheckResult = 'ok' | 'unavailable' | 'pending' | 'unknown';

export interface Readiness {
  ready: boolean;
  checks: { database: CheckResult; migrations: CheckResult };
}

/** Default budget for each phase of a readiness check (getting a connection, running queries). */
export const DEFAULT_READINESS_TIMEOUT_MS = 2_000;

// Extra time the client waits beyond statement_timeout before giving up on the
// connection itself, e.g. when the network drops and the server never replies.
const CLIENT_GRACE_MS = 500;

class DeadlineExceeded extends Error {}

@Injectable()
export class ReadinessService {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(READINESS_TIMEOUT_MS) private readonly timeoutMs: number,
  ) {}

  /**
   * Ready means the database answers and every migration on disk has been
   * applied. Every part of the check is bounded, and the connection is always
   * returned (or destroyed), so probes during an outage can't exhaust the pool.
   */
  async check(): Promise<Readiness> {
    let client: PoolClient;
    try {
      client = await acquire(this.pool, this.timeoutMs);
    } catch (error) {
      this.logger.debug(
        { event: 'readiness.database_failed', err: error },
        'No database connection',
      );
      return notReady('unavailable', 'unknown');
    }

    let broken: Error | undefined;
    try {
      return await deadline(this.runChecks(client), this.timeoutMs + CLIENT_GRACE_MS);
    } catch (error) {
      // Only reached if the server stopped answering entirely; statement_timeout
      // handles slow or blocked queries. Destroy the connection rather than reuse it.
      broken = error instanceof Error ? error : new Error(String(error));
      this.logger.debug(
        { event: 'readiness.database_failed', err: error },
        'Database not answering',
      );
      return notReady('unavailable', 'unknown');
    } finally {
      client.release(broken);
    }
  }

  private async runChecks(client: PoolClient): Promise<Readiness> {
    // statement_timeout makes PostgreSQL cancel a slow or blocked query itself, so
    // nothing is left running on the server after the probe answers.
    await client.query('BEGIN READ ONLY');
    try {
      await client.query(`SET LOCAL statement_timeout = ${String(Math.trunc(this.timeoutMs))}`);
      try {
        await client.query('SELECT 1');
      } catch (error) {
        this.logger.debug(
          { event: 'readiness.database_failed', err: error },
          'Database not answering',
        );
        return notReady('unavailable', 'unknown');
      }
      try {
        const status = await migrationStatus(client);
        if (status.pending.length > 0) {
          this.logger.debug(
            { event: 'readiness.migrations_pending', pending: status.pending },
            'Migrations pending',
          );
          return notReady('ok', 'pending');
        }
      } catch (error) {
        this.logger.debug(
          { event: 'readiness.migrations_failed', err: error },
          'Migration check failed',
        );
        return notReady('ok', 'unknown');
      }
      return { ready: true, checks: { database: 'ok', migrations: 'ok' } };
    } finally {
      await client.query('ROLLBACK');
    }
  }
}

function notReady(database: CheckResult, migrations: CheckResult): Readiness {
  return { ready: false, checks: { database, migrations } };
}

/**
 * pool.connect() with a time limit. If the limit wins, the connection that
 * arrives later is released straight away instead of being leaked.
 */
async function acquire(pool: Pool, ms: number): Promise<PoolClient> {
  const pending = pool.connect();
  try {
    return await deadline(pending, ms);
  } catch (error) {
    if (error instanceof DeadlineExceeded) {
      pending.then(
        (late) => {
          late.release();
        },
        () => undefined,
      );
    }
    throw error;
  }
}

async function deadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new DeadlineExceeded(`Timed out after ${String(ms)} ms`));
    }, ms);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}
