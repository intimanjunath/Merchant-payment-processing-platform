import { Client } from 'pg';
import request from 'supertest';

import { migrateTestDatabase, startTestApi, type TestApi } from '../helpers/api';
import { testDatabaseUrl } from '../helpers/test-db';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('API skeleton', () => {
  let api: TestApi;

  beforeAll(async () => {
    await migrateTestDatabase();
    api = await startTestApi();
  });

  afterAll(async () => {
    await api.app.close();
  });

  describe('request IDs', () => {
    it('generates one when the caller sends none', async () => {
      const res = await request(api.app.getHttpServer()).get('/health').expect(200);

      expect(res.body).toEqual({ status: 'ok' });
      expect(res.headers['x-request-id']).toMatch(UUID);
    });

    it("echoes the caller's ID when it is safe", async () => {
      const res = await request(api.app.getHttpServer())
        .get('/health')
        .set('X-Request-Id', 'caller-req-123')
        .expect(200);

      expect(res.headers['x-request-id']).toBe('caller-req-123');
    });

    it('replaces an unsafe ID', async () => {
      const res = await request(api.app.getHttpServer())
        .get('/health')
        .set('X-Request-Id', 'has spaces and is suspicious')
        .expect(200);

      expect(res.headers['x-request-id']).toMatch(UUID);
    });
  });

  describe('error envelope', () => {
    it('returns NOT_FOUND for an unknown route, with the same request ID as the header', async () => {
      const res = await request(api.app.getHttpServer())
        .get('/no-such-route')
        .set('X-Request-Id', 'missing-route-1')
        .expect(404);

      expect(res.body).toEqual({
        error: {
          code: 'NOT_FOUND',
          message: 'The requested resource was not found.',
          requestId: 'missing-route-1',
        },
      });
      expect(res.headers['x-request-id']).toBe('missing-route-1');
    });

    it('returns VALIDATION_ERROR for malformed JSON', async () => {
      const res = await request(api.app.getHttpServer())
        .post('/health')
        .set('Content-Type', 'application/json')
        .send('{"amount": 15')
        .expect(400);

      expect(res.body.error).toMatchObject({
        code: 'VALIDATION_ERROR',
        message: 'The request body is not valid JSON.',
        requestId: res.headers['x-request-id'],
      });
    });

    it('rejects a body over the size limit', async () => {
      const res = await request(api.app.getHttpServer())
        .post('/health')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ padding: 'x'.repeat(70_000) }))
        .expect(413);

      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('unsupported body encodings', () => {
    it('returns 415 for an unsupported charset', async () => {
      const res = await request(api.app.getHttpServer())
        .post('/health')
        .set('Content-Type', 'application/json; charset=latin1')
        .send('{"amount":1500}')
        .expect(415);

      expect(res.body).toEqual({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'The request body uses an unsupported charset.',
          requestId: res.headers['x-request-id'],
        },
      });
    });

    it('returns 415 for an unsupported Content-Encoding', async () => {
      const res = await request(api.app.getHttpServer())
        .post('/health')
        .set('Content-Type', 'application/json')
        .set('Content-Encoding', 'x-unknown')
        .send('{"amount":1500}')
        .expect(415);

      expect(res.body.error).toEqual({
        code: 'VALIDATION_ERROR',
        message: 'The request body uses an unsupported Content-Encoding.',
        requestId: res.headers['x-request-id'],
      });
    });

    it('does not log these client errors as unexpected failures', () => {
      expect(api.logs.filter((line) => line.event === 'http.request.failed')).toEqual([]);
    });
  });

  describe('readiness', () => {
    it('is ready when the database answers and migrations are applied', async () => {
      const res = await request(api.app.getHttpServer()).get('/ready').expect(200);

      expect(res.body).toEqual({ status: 'ready', checks: { database: 'ok', migrations: 'ok' } });
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('returns 503 when the database cannot be reached', async () => {
      const unreachable = await startTestApi({
        databaseUrl: 'postgres://nobody:nothing@127.0.0.1:1/none',
      });
      try {
        const res = await request(unreachable.app.getHttpServer()).get('/ready').expect(503);

        expect(res.body).toEqual({
          status: 'not_ready',
          checks: { database: 'unavailable', migrations: 'unknown' },
        });
        // Logged from inside the handler: the async context carried the request ID there.
        expect(
          unreachable.logs.find((line) => line.event === 'readiness.database_failed'),
        ).toMatchObject({ requestId: res.headers['x-request-id'] });
        // A failing probe is a warning, not an error.
        expect(
          unreachable.logs.find((line) => line.event === 'http.request.completed'),
        ).toMatchObject({ level: 'warn', route: '/ready', status: 503 });
      } finally {
        await unreachable.app.close();
      }
    });

    it('returns 503 when migrations are pending', async () => {
      const emptyDb = await createEmptyDatabase('ready_pending_check');
      const pending = await startTestApi({ databaseUrl: emptyDb });
      try {
        const res = await request(pending.app.getHttpServer()).get('/ready').expect(503);

        expect(res.body).toEqual({
          status: 'not_ready',
          checks: { database: 'ok', migrations: 'pending' },
        });
      } finally {
        await pending.app.close();
      }
    });
  });

  describe('readiness under a stuck database', () => {
    const TIMEOUT_MS = 300;

    it('cancels a blocked query on the server and returns every connection', async () => {
      // Hold an exclusive lock on schema_migrations so the migration check blocks.
      const locker = new Client({ connectionString: testDatabaseUrl() });
      await locker.connect();
      await locker.query('BEGIN');
      await locker.query('LOCK TABLE schema_migrations IN ACCESS EXCLUSIVE MODE');

      const stuck = await startTestApi({
        readinessTimeoutMs: TIMEOUT_MS,
        applicationName: 'api-test-readiness-lock',
      });
      try {
        // More probes than the pool has connections (2): a leak would make the
        // later ones fail to get a connection and report the database unavailable.
        for (let probe = 1; probe <= 4; probe += 1) {
          const startedAt = Date.now();
          const res = await request(stuck.app.getHttpServer()).get('/ready').expect(503);

          expect(res.body.checks).toEqual({ database: 'ok', migrations: 'unknown' });
          expect(Date.now() - startedAt).toBeLessThan(1_500);
        }

        // Nothing is still checked out of the pool...
        expect(stuck.pool.waitingCount).toBe(0);
        expect(stuck.pool.idleCount).toBe(stuck.pool.totalCount);
        // ...and no query from the probes is still waiting on the server.
        const waiting = await locker.query<{ count: string }>(
          `SELECT count(*) FROM pg_stat_activity
           WHERE application_name = 'api-test-readiness-lock' AND state = 'active'`,
        );
        expect(waiting.rows[0]?.count).toBe('0');
      } finally {
        await locker.query('ROLLBACK');
        await locker.end();
        await stuck.app.close();
      }
    });

    it('gives up waiting for a connection and releases the one that arrives late', async () => {
      const busy = await startTestApi({ readinessTimeoutMs: TIMEOUT_MS });
      // Take every connection the app's pool allows (max 2).
      const held = await Promise.all([busy.pool.connect(), busy.pool.connect()]);
      try {
        const res = await request(busy.app.getHttpServer()).get('/ready').expect(503);
        expect(res.body.checks).toEqual({ database: 'unavailable', migrations: 'unknown' });
      } finally {
        for (const client of held) client.release();
      }

      // The probe's abandoned connect() now gets a connection; it must hand it back.
      await waitFor(
        () => busy.pool.waitingCount === 0 && busy.pool.idleCount === busy.pool.totalCount,
      );
      const after = await request(busy.app.getHttpServer()).get('/ready').expect(200);
      expect(after.body.status).toBe('ready');
      await busy.app.close();
    });
  });

  describe('logs and metrics', () => {
    it('logs each request once with its ID, route template, status and duration', async () => {
      await request(api.app.getHttpServer())
        .get('/no-such-route')
        .set('X-Request-Id', 'log-check-1')
        .set('Authorization', 'Bearer must-not-appear')
        .expect(404);

      const lines = api.logs.filter((line) => line.requestId === 'log-check-1');
      expect(lines).toEqual([
        expect.objectContaining({
          event: 'http.request.completed',
          service: 'api',
          level: 'info',
          method: 'GET',
          route: 'unmatched',
          status: 404,
          durationMs: expect.any(Number),
          traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
        }),
      ]);
      expect(JSON.stringify(api.logs)).not.toContain('must-not-appear');
    });

    it('logs probes at debug so they do not drown real traffic', async () => {
      await request(api.app.getHttpServer()).get('/health').set('X-Request-Id', 'probe-1');

      expect(api.logs.find((line) => line.requestId === 'probe-1')).toMatchObject({
        level: 'debug',
        route: '/health',
      });
    });

    it('continues the caller trace from a valid traceparent', async () => {
      const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
      await request(api.app.getHttpServer())
        .get('/health')
        .set('X-Request-Id', 'trace-1')
        .set('traceparent', `00-${traceId}-00f067aa0ba902b7-01`);

      expect(api.logs.find((line) => line.requestId === 'trace-1')).toMatchObject({ traceId });
    });

    it('exposes request metrics by route template with bounded labels', async () => {
      await request(api.app.getHttpServer()).get('/health');
      await request(api.app.getHttpServer()).get('/random-path-1');
      await request(api.app.getHttpServer()).get('/random-path-2');

      const res = await request(api.app.getHttpServer()).get('/metrics').expect(200);

      expect(res.headers['content-type']).toContain('text/plain');
      expect(res.text).toMatch(
        /http_requests_total\{method="GET",route="\/health",status_class="2xx",service="api"\} \d+/,
      );
      expect(res.text).toMatch(/route="unmatched",status_class="4xx"/);
      expect(res.text).not.toContain('random-path');
      expect(res.text).toContain('http_request_duration_seconds_bucket');
      expect(res.text).toContain('process_cpu_user_seconds_total');
    });
  });
});

/** Creates (or recreates) an empty database next to the test database and returns its URL. */
async function createEmptyDatabase(name: string): Promise<string> {
  const admin = new Client({ connectionString: testDatabaseUrl() });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const url = new URL(testDatabaseUrl());
  url.pathname = `/${name}`;
  return url.toString();
}

async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
