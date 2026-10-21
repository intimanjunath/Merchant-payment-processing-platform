import { Client } from 'pg';
import request from 'supertest';

import {
  clearLoginAttempts,
  migrateTestDatabase,
  SEEDED_MERCHANTS,
  startTestApi,
  type TestApi,
} from '../helpers/api';
import { testDatabaseUrl } from '../helpers/test-db';

const { acme, bicycle } = SEEDED_MERCHANTS;
const ALLOWED_ORIGIN = 'http://localhost:5173';
const EVIL_ORIGIN = 'https://evil.example';
const credentials = (merchant: typeof acme) => ({
  email: merchant.email,
  password: merchant.password,
});

beforeAll(async () => {
  await migrateTestDatabase({ seed: true });
  await clearLoginAttempts();
});

afterAll(async () => {
  // Leave the seeded merchants usable for every other suite.
  await clearLoginAttempts();
});

describe('CSRF and origin checks', () => {
  let api: TestApi;
  const server = () => api.app.getHttpServer();

  beforeAll(async () => {
    api = await startTestApi();
  });

  afterAll(async () => {
    await api.app.close();
  });

  async function browserSession() {
    const res = await request(server()).post('/auth/login').send(credentials(acme)).expect(200);
    const cookie = /pp_session=([^;]+);/.exec(String(res.headers['set-cookie']))?.[1] ?? '';
    return { cookie: `pp_session=${cookie}`, csrfToken: String(res.body.csrfToken) };
  }

  const logout = (cookie: string) => request(server()).post('/auth/logout').set('Cookie', cookie);

  it('rejects a cookie-authenticated mutation without the CSRF token, leaving the session intact', async () => {
    const { cookie } = await browserSession();

    const res = await logout(cookie).expect(403);

    expect(res.body.error).toMatchObject({
      code: 'CSRF_REJECTED',
      message: 'The request was rejected.',
    });
    await request(server()).get('/auth/session').set('Cookie', cookie).expect(200);
  });

  it('rejects a wrong token and a token that belongs to another session', async () => {
    const mine = await browserSession();
    const other = await browserSession();

    await logout(mine.cookie).set('X-CSRF-Token', 'not-the-token').expect(403);
    await logout(mine.cookie).set('X-CSRF-Token', other.csrfToken).expect(403);
  });

  it('rejects the right token from a disallowed Origin or Referer', async () => {
    const { cookie, csrfToken } = await browserSession();

    await logout(cookie).set('X-CSRF-Token', csrfToken).set('Origin', EVIL_ORIGIN).expect(403);
    await logout(cookie)
      .set('X-CSRF-Token', csrfToken)
      .set('Referer', `${EVIL_ORIGIN}/page`)
      .expect(403);
  });

  it('accepts the right token from the allowed origin', async () => {
    const { cookie, csrfToken } = await browserSession();

    await logout(cookie).set('X-CSRF-Token', csrfToken).set('Origin', ALLOWED_ORIGIN).expect(204);
  });

  it('accepts the right token with no origin at all (non-browser cookie client)', async () => {
    const { cookie, csrfToken } = await browserSession();

    await logout(cookie).set('X-CSRF-Token', csrfToken).expect(204);
  });

  it('does not require a CSRF token for Bearer requests', async () => {
    const token = await request(server())
      .post('/auth/token')
      .send(credentials(bicycle))
      .expect(200);

    await request(server())
      .post('/auth/logout')
      .set('Authorization', `Bearer ${String(token.body.accessToken)}`)
      .set('Origin', EVIL_ORIGIN)
      .expect(204);
  });

  it('does not require a CSRF token for safe methods', async () => {
    const { cookie } = await browserSession();

    await request(server()).get('/auth/session').set('Cookie', cookie).expect(200);
  });

  it('answers 401 before 403 when there is no credential', async () => {
    const res = await request(server()).post('/auth/logout').set('Origin', EVIL_ORIGIN).expect(401);

    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects login and token requests from a disallowed origin (login CSRF)', async () => {
    const login = await request(server())
      .post('/auth/login')
      .set('Origin', EVIL_ORIGIN)
      .send(credentials(acme))
      .expect(403);
    await request(server())
      .post('/auth/token')
      .set('Origin', EVIL_ORIGIN)
      .send(credentials(acme))
      .expect(403);

    expect(login.body.error.code).toBe('CSRF_REJECTED');
    expect(login.headers['set-cookie']).toBeUndefined();
    await request(server())
      .post('/auth/login')
      .set('Origin', ALLOWED_ORIGIN)
      .send(credentials(acme))
      .expect(200);
  });

  it('logs rejections without the token', () => {
    const rejections = api.logs.filter((line) => line.event === 'auth.csrf_rejected');

    expect(rejections.map((line) => line.reason)).toEqual(
      expect.arrayContaining([
        'csrf_token_invalid',
        'origin_not_allowed',
        'login_origin_not_allowed',
      ]),
    );
    expect(JSON.stringify(rejections)).not.toContain('not-the-token');
  });
});

describe('login throttling', () => {
  const WINDOW_SECONDS = 2;

  beforeEach(async () => {
    await clearLoginAttempts();
  });

  const wrongPassword = (merchant: typeof acme) => ({
    email: merchant.email,
    password: 'wrong-password',
  });

  it('blocks the attempt after the per-email limit, then allows login once the window passes', async () => {
    const api = await startTestApi({
      throttle: { windowSeconds: WINDOW_SECONDS, maxPerEmail: 3, maxPerIp: 100 },
    });
    try {
      const server = api.app.getHttpServer();
      // Start at the beginning of a window so all four attempts land in the same one.
      await waitForWindowStart(WINDOW_SECONDS);
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await request(server).post('/auth/login').send(wrongPassword(acme)).expect(401);
      }

      // Even the right password is refused while the limit holds.
      const blocked = await request(server).post('/auth/login').send(credentials(acme)).expect(429);
      expect(blocked.body.error).toMatchObject({ code: 'RATE_LIMITED' });
      const retryAfter = Number(blocked.headers['retry-after']);
      expect(retryAfter).toBeGreaterThanOrEqual(1);
      expect(retryAfter).toBeLessThanOrEqual(WINDOW_SECONDS);
      expect(blocked.headers['set-cookie']).toBeUndefined();

      // The other merchant is unaffected.
      await request(server).post('/auth/login').send(credentials(bicycle)).expect(200);

      await sleep(retryAfter * 1000 + 100);
      await request(server).post('/auth/login').send(credentials(acme)).expect(200);
      expect(api.logs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event: 'auth.throttled', scope: 'email', level: 'warn' }),
        ]),
      );
    } finally {
      await api.app.close();
    }
  });

  it('applies the same limit to API-client logins', async () => {
    const api = await startTestApi({
      throttle: { windowSeconds: 60, maxPerEmail: 2, maxPerIp: 100 },
    });
    try {
      const server = api.app.getHttpServer();
      await request(server).post('/auth/token').send(wrongPassword(acme)).expect(401);
      await request(server).post('/auth/login').send(wrongPassword(acme)).expect(401);
      await request(server).post('/auth/token').send(credentials(acme)).expect(429);
    } finally {
      await api.app.close();
    }
  });

  it('forgives earlier failures after a successful login', async () => {
    const api = await startTestApi({
      throttle: { windowSeconds: 60, maxPerEmail: 3, maxPerIp: 100 },
    });
    try {
      const server = api.app.getHttpServer();
      await request(server).post('/auth/login').send(wrongPassword(acme)).expect(401);
      await request(server).post('/auth/login').send(wrongPassword(acme)).expect(401);
      await request(server).post('/auth/login').send(credentials(acme)).expect(200);
      await request(server).post('/auth/login').send(wrongPassword(acme)).expect(401);
      await request(server).post('/auth/login').send(wrongPassword(acme)).expect(401);
      // Two failures since the success: still under the limit of three.
      await request(server).post('/auth/login').send(credentials(acme)).expect(200);
    } finally {
      await api.app.close();
    }
  });

  it('holds the limit against a burst of parallel guesses', async () => {
    const api = await startTestApi({
      throttle: { windowSeconds: 60, maxPerEmail: 3, maxPerIp: 100 },
    });
    try {
      // Bind once; otherwise supertest calls listen() for every parallel request.
      await api.app.listen(0, '127.0.0.1');
      const server = api.app.getHttpServer();
      const statuses = await Promise.all(
        Array.from({ length: 10 }, () =>
          request(server)
            .post('/auth/login')
            .send(wrongPassword(acme))
            .then((res) => res.status),
        ),
      );

      // Only three guesses reach the password check; the rest are refused.
      expect(statuses.filter((status) => status === 401)).toHaveLength(3);
      expect(statuses.filter((status) => status === 429)).toHaveLength(7);
    } finally {
      await api.app.close();
    }
  });

  it('limits failures per client IP across different emails', async () => {
    const api = await startTestApi({
      throttle: { windowSeconds: 60, maxPerEmail: 100, maxPerIp: 3 },
    });
    try {
      const server = api.app.getHttpServer();
      for (const n of [1, 2, 3]) {
        await request(server)
          .post('/auth/login')
          .send({ email: `guess${String(n)}@example.test`, password: 'x' })
          .expect(401);
      }

      await request(server).post('/auth/login').send(credentials(acme)).expect(429);
      expect(api.logs).toEqual(
        expect.arrayContaining([expect.objectContaining({ event: 'auth.throttled', scope: 'ip' })]),
      );
    } finally {
      await api.app.close();
    }
  });

  it('stores only hashes of emails and addresses', async () => {
    const api = await startTestApi({ throttle: { windowSeconds: 60 } });
    try {
      await request(api.app.getHttpServer())
        .post('/auth/login')
        .send(wrongPassword(acme))
        .expect(401);
    } finally {
      await api.app.close();
    }

    const client = new Client({ connectionString: testDatabaseUrl() });
    await client.connect();
    try {
      const rows = await client.query<{ scope: string; subject_hash: string; failures: number }>(
        'SELECT scope, subject_hash, failures FROM login_attempts ORDER BY scope',
      );
      expect(rows.rows.map((row) => row.scope)).toEqual(['email', 'ip']);
      for (const row of rows.rows) {
        expect(row.subject_hash).toMatch(/^[0-9a-f]{64}$/);
        expect(row.failures).toBe(1);
      }
      expect(JSON.stringify(rows.rows)).not.toContain(acme.email);
    } finally {
      await client.end();
    }
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Waits until just after a window boundary, so a burst of requests shares one window. */
async function waitForWindowStart(windowSeconds: number): Promise<void> {
  const windowMs = windowSeconds * 1000;
  const intoWindow = Date.now() % windowMs;
  if (intoWindow > 50) await sleep(windowMs - intoWindow + 20);
}
