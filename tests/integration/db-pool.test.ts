import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { createPool, type PoolErrorDetails } from '@payments/db';
import { Client, type Pool } from 'pg';

import { testDatabaseUrl } from '../helpers/test-db';

const DB_PACKAGE_DIST = path.resolve(__dirname, '../../packages/db/dist');

// Loses the pool's idle connection, then queries again, in a separate Node process,
// so the test can see whether the process itself survives. "guarded" uses
// createPool; "bare" uses pg.Pool with no error listener as a control.
const CHILD_SCRIPT = `
const { Client, Pool } = require('pg');
const { createPool } = require(process.env.DB_PACKAGE_DIST);
const url = process.env.TEST_DATABASE_URL;
const pid = async (pool) => (await pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
(async () => {
  const pool = process.argv[1] === 'bare'
    ? new Pool({ connectionString: url, max: 1 })
    : createPool(url, { applicationName: 'idle-loss-child', max: 1, onIdleClientError: () => {} });
  const first = await pid(pool);
  const admin = new Client({ connectionString: url });
  await admin.connect();
  await admin.query('SELECT pg_terminate_backend($1)', [first]);
  await admin.end();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const second = await pid(pool);
  await pool.end();
  console.log(JSON.stringify({ survived: true, replaced: second !== first }));
})().catch((error) => { console.error(error); process.exit(2); });
`;

function runChild(mode: 'guarded' | 'bare'): { status: number | null; stdout: string } {
  const result = spawnSync(process.execPath, ['-e', CHILD_SCRIPT, mode], {
    cwd: path.resolve(__dirname, '../..'),
    env: { ...process.env, DB_PACKAGE_DIST },
    encoding: 'utf8',
    timeout: 15_000,
  });
  return { status: result.status, stdout: result.stdout };
}

// Postgres error code for a connection ended by pg_terminate_backend.
const ADMIN_SHUTDOWN = '57P01';

async function backendPid(pool: Pool): Promise<number> {
  const result = await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  const pid = result.rows[0]?.pid;
  if (pid === undefined) throw new Error('pg_backend_pid() returned no row');
  return pid;
}

async function terminateBackend(pid: number): Promise<void> {
  const admin = new Client({ connectionString: testDatabaseUrl() });
  await admin.connect();
  try {
    await admin.query('SELECT pg_terminate_backend($1)', [pid]);
  } finally {
    await admin.end();
  }
}

describe('database pool', () => {
  it('keeps the process alive when an idle connection is lost (separate process)', () => {
    const guarded = runChild('guarded');
    expect(guarded.status).toBe(0);
    expect(JSON.parse(guarded.stdout.trim())).toEqual({ survived: true, replaced: true });
  });

  it('control: a pg.Pool without an error listener crashes the process', () => {
    const bare = runChild('bare');
    expect(bare.status).not.toBe(0);
    expect(bare.stdout).not.toContain('survived');
  });

  it('survives losing an idle connection and opens a new one for the next query', async () => {
    let reported: (details: PoolErrorDetails) => void = () => undefined;
    const errorReported = new Promise<PoolErrorDetails>((resolve) => {
      reported = resolve;
    });
    const pool = createPool(testDatabaseUrl(), {
      applicationName: 'pool-test',
      max: 1,
      onIdleClientError: (details) => {
        reported(details);
      },
    });

    try {
      // The pool's only listener is the one createPool adds. If it were missing,
      // the terminated connection would raise an unhandled 'error' event and fail
      // this test with an uncaught exception.
      expect(pool.listenerCount('error')).toBe(1);

      const firstPid = await backendPid(pool); // connection is now idle in the pool
      await terminateBackend(firstPid);

      await expect(errorReported).resolves.toMatchObject({
        applicationName: 'pool-test',
        code: ADMIN_SHUTDOWN,
      });

      const secondPid = await backendPid(pool);
      expect(secondPid).not.toBe(firstPid);
    } finally {
      await pool.end();
    }
  });

  it('keeps working when the error reporter itself throws', async () => {
    let reporterCalled: () => void = () => undefined;
    const called = new Promise<void>((resolve) => {
      reporterCalled = resolve;
    });
    const pool = createPool(testDatabaseUrl(), {
      applicationName: 'pool-test-throwing-reporter',
      max: 1,
      onIdleClientError: () => {
        reporterCalled();
        throw new Error('reporter failed');
      },
    });

    try {
      const firstPid = await backendPid(pool);
      await terminateBackend(firstPid);
      await called;

      expect(await backendPid(pool)).not.toBe(firstPid);
    } finally {
      await pool.end();
    }
  });

  it('writes safe JSON to stderr by default, without the connection string', async () => {
    const lines: string[] = [];
    const write = jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    const pool = createPool(testDatabaseUrl(), { applicationName: 'pool-test-default', max: 1 });

    try {
      const firstPid = await backendPid(pool);
      await terminateBackend(firstPid);
      await waitFor(() => lines.length > 0);

      const entry = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
      expect(entry).toMatchObject({
        level: 'warn',
        event: 'db.pool.idle_client_error',
        applicationName: 'pool-test-default',
        code: ADMIN_SHUTDOWN,
      });
      const password = new URL(testDatabaseUrl()).password;
      expect(lines[0]).not.toContain(password);
      expect(lines[0]).not.toContain(testDatabaseUrl());
    } finally {
      write.mockRestore();
      await pool.end();
    }
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
