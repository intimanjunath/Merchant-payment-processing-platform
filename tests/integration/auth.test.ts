import { createHmac } from 'node:crypto';

import jwt from 'jsonwebtoken';
import { Client } from 'pg';
import request from 'supertest';

import {
  migrateTestDatabase,
  SEEDED_MERCHANTS,
  startTestApi,
  TEST_CSRF_SECRET,
  TEST_JWT,
  type TestApi,
} from '../helpers/api';
import { testDatabaseUrl } from '../helpers/test-db';

const { acme, bicycle } = SEEDED_MERCHANTS;

describe('authentication', () => {
  let api: TestApi;
  const server = () => api.app.getHttpServer();

  beforeAll(async () => {
    await migrateTestDatabase({ seed: true });
    api = await startTestApi();
  });

  afterAll(async () => {
    await api.app.close();
  });

  const credentials = (merchant: typeof acme) => ({
    email: merchant.email,
    password: merchant.password,
  });

  async function browserLogin(merchant = acme) {
    const res = await request(server()).post('/auth/login').send(credentials(merchant)).expect(200);
    return { res, cookie: sessionCookie(res) };
  }

  async function apiToken(merchant = acme): Promise<string> {
    const res = await request(server()).post('/auth/token').send(credentials(merchant)).expect(200);
    return (res.body as { accessToken: string }).accessToken;
  }

  describe('POST /auth/login', () => {
    it('opens a browser session: HttpOnly cookie, merchant, expiry and CSRF token', async () => {
      const { res, cookie } = await browserLogin();

      const setCookie = String(res.headers['set-cookie']);
      expect(setCookie).toMatch(/^pp_session=[^;]+;/);
      expect(setCookie).toMatch(/HttpOnly/i);
      expect(setCookie).toMatch(/SameSite=Lax/i);
      expect(setCookie).toMatch(/Path=\//);
      expect(setCookie).toMatch(/Max-Age=28\d{3}/); // about 8 hours
      expect(setCookie).not.toMatch(/Secure/i); // COOKIE_SECURE=false locally
      expect(res.headers['cache-control']).toBe('no-store');

      expect(res.body).toEqual({
        merchant: { id: expect.any(String), email: acme.email, name: acme.name },
        expiresAt: expect.any(String),
        csrfToken: expect.any(String),
      });
      const hoursLeft = (Date.parse(String(res.body.expiresAt)) - Date.now()) / 3_600_000;
      expect(hoursLeft).toBeGreaterThan(7.9);
      expect(hoursLeft).toBeLessThanOrEqual(8);

      // The token travels only in the cookie, and is bound to its session.
      expect(JSON.stringify(res.body)).not.toContain(cookie);
      const { sid } = jwt.decode(cookie) as { sid: string };
      expect(res.body.csrfToken).toBe(
        createHmac('sha256', TEST_CSRF_SECRET).update(sid).digest('base64url'),
      );
    });

    it('treats the email case-insensitively', async () => {
      await request(server())
        .post('/auth/login')
        .send({ email: acme.email.toUpperCase(), password: acme.password })
        .expect(200);
    });

    it('gives the same generic answer for a wrong password and an unknown email', async () => {
      const wrongPassword = await request(server())
        .post('/auth/login')
        .send({ email: acme.email, password: 'not-the-password' })
        .expect(401);
      const unknownEmail = await request(server())
        .post('/auth/login')
        .send({ email: 'nobody@example.test', password: 'whatever' })
        .expect(401);

      const expected = { code: 'INVALID_CREDENTIALS', message: 'Email or password is incorrect.' };
      expect(wrongPassword.body.error).toMatchObject(expected);
      expect(unknownEmail.body.error).toMatchObject(expected);
      expect(wrongPassword.headers['set-cookie']).toBeUndefined();
    });

    it('validates the body and rejects unknown fields', async () => {
      const missing = await request(server())
        .post('/auth/login')
        .send({ email: acme.email })
        .expect(400);
      const extra = await request(server())
        .post('/auth/login')
        .send({ ...credentials(acme), cardNumber: '4242424242424242' })
        .expect(400);

      expect(missing.body.error.code).toBe('VALIDATION_ERROR');
      expect(extra.body.error.details.issues).toEqual(
        expect.arrayContaining([expect.stringContaining('cardNumber')]),
      );
      expect(JSON.stringify(extra.body)).not.toContain('4242424242424242');
    });

    it('never logs the password or the token', async () => {
      const { cookie } = await browserLogin();
      const logged = JSON.stringify(api.logs);

      expect(logged).not.toContain(acme.password);
      expect(logged).not.toContain(cookie);
      expect(api.logs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event: 'auth.login.succeeded', clientKind: 'browser' }),
          expect.objectContaining({ event: 'auth.login.failed', level: 'warn' }),
        ]),
      );
    });
  });

  describe('POST /auth/token', () => {
    it('returns a Bearer token in the body and sets no cookie', async () => {
      const res = await request(server()).post('/auth/token').send(credentials(acme)).expect(200);

      expect(res.body).toEqual({
        accessToken: expect.any(String),
        tokenType: 'Bearer',
        expiresAt: expect.any(String),
      });
      expect(res.headers['set-cookie']).toBeUndefined();
    });
  });

  describe('GET /auth/session', () => {
    it('works with the session cookie and returns the same CSRF token as login', async () => {
      const { res: login, cookie } = await browserLogin();
      const res = await request(server())
        .get('/auth/session')
        .set('Cookie', `pp_session=${cookie}`)
        .expect(200);

      expect(res.body).toEqual({
        merchant: login.body.merchant,
        expiresAt: login.body.expiresAt,
        csrfToken: login.body.csrfToken,
      });
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('works with a Bearer token, with no CSRF token for API clients', async () => {
      const token = await apiToken(bicycle);
      const res = await request(server())
        .get('/auth/session')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.merchant.email).toBe(bicycle.email);
      expect(res.body.csrfToken).toBeNull();
    });

    it('requires a credential', async () => {
      const res = await request(server()).get('/auth/session').expect(401);

      expect(res.body.error).toMatchObject({
        code: 'UNAUTHENTICATED',
        message: 'Authentication is required.',
      });
    });
  });

  describe('rejected tokens', () => {
    it('rejects a token whose session expired in the database', async () => {
      const token = await apiToken();
      const { sid } = jwt.decode(token) as { sid: string };
      await sql("UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id = $1", [
        sid,
      ]);

      await request(server())
        .get('/auth/session')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
    });

    it('rejects a token past its exp claim', async () => {
      const token = await apiToken();
      const claims = jwt.decode(token) as { sub: string; sid: string };
      const expired = jwt.sign(
        { sid: claims.sid, exp: Math.floor(Date.now() / 1000) - 5 },
        TEST_JWT.secret,
        {
          algorithm: 'HS256',
          subject: claims.sub,
          issuer: TEST_JWT.issuer,
          audience: TEST_JWT.audience,
        },
      );

      await request(server())
        .get('/auth/session')
        .set('Authorization', `Bearer ${expired}`)
        .expect(401);
    });

    it('rejects a token after logout, including the cookie that was used to log out', async () => {
      const { cookie } = await browserLogin();
      const logout = await request(server())
        .post('/auth/logout')
        .set('Cookie', `pp_session=${cookie}`)
        .expect(204);

      expect(String(logout.headers['set-cookie'])).toMatch(
        /pp_session=;.*(Expires=Thu, 01 Jan 1970|Max-Age=0)/i,
      );
      await request(server())
        .get('/auth/session')
        .set('Cookie', `pp_session=${cookie}`)
        .expect(401);
    });

    it('rejects a token signed with another secret, alg none, or a tampered payload', async () => {
      const token = await apiToken();
      const claims = jwt.decode(token) as { sub: string; sid: string; exp: number };
      const body = { sid: claims.sid, exp: claims.exp };
      const options = { subject: claims.sub, issuer: TEST_JWT.issuer, audience: TEST_JWT.audience };
      const forgeries = [
        jwt.sign(body, 'some-other-secret-0123456789abcdefgh', { ...options, algorithm: 'HS256' }),
        jwt.sign({ ...body, sub: claims.sub, iss: TEST_JWT.issuer, aud: TEST_JWT.audience }, '', {
          algorithm: 'none',
        }),
        token.slice(0, -2) + (token.endsWith('A') ? 'BB' : 'AA'),
      ];

      for (const forged of forgeries) {
        await request(server())
          .get('/auth/session')
          .set('Authorization', `Bearer ${forged}`)
          .expect(401);
      }
    });

    it("rejects one merchant's session ID inside a token for another merchant", async () => {
      const acmeToken = await apiToken(acme);
      const bicycleToken = await apiToken(bicycle);
      const { sid: acmeSession, exp } = jwt.decode(acmeToken) as { sid: string; exp: number };
      const { sub: bicycleMerchant } = jwt.decode(bicycleToken) as { sub: string };
      // Correctly signed, but the session does not belong to this merchant.
      const mixed = jwt.sign({ sid: acmeSession, exp }, TEST_JWT.secret, {
        algorithm: 'HS256',
        subject: bicycleMerchant,
        issuer: TEST_JWT.issuer,
        audience: TEST_JWT.audience,
      });

      await request(server())
        .get('/auth/session')
        .set('Authorization', `Bearer ${mixed}`)
        .expect(401);
    });

    it('answers 401, not 500, for a signed token whose IDs are not UUIDs', async () => {
      const notUuid = jwt.sign(
        { sid: 'abc', exp: Math.floor(Date.now() / 1000) + 600 },
        TEST_JWT.secret,
        {
          algorithm: 'HS256',
          subject: 'xyz',
          issuer: TEST_JWT.issuer,
          audience: TEST_JWT.audience,
        },
      );

      await request(server())
        .get('/auth/session')
        .set('Authorization', `Bearer ${notUuid}`)
        .expect(401);
    });
  });

  describe('Authorization header precedence', () => {
    it('uses the header and ignores a valid cookie when the header is invalid', async () => {
      const { cookie } = await browserLogin();

      await request(server())
        .get('/auth/session')
        .set('Cookie', `pp_session=${cookie}`)
        .set('Authorization', 'Bearer not-a-real-token')
        .expect(401);
    });

    it('rejects a non-Bearer Authorization header even with a valid cookie', async () => {
      const { cookie } = await browserLogin();

      await request(server())
        .get('/auth/session')
        .set('Cookie', `pp_session=${cookie}`)
        .set('Authorization', 'Basic YWRtaW46YWRtaW4=')
        .expect(401);
    });

    it('accepts a valid header alongside an invalid cookie', async () => {
      const token = await apiToken();

      const res = await request(server())
        .get('/auth/session')
        .set('Cookie', 'pp_session=garbage')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(res.body.merchant.email).toBe(acme.email);
    });
  });
});

function sessionCookie(res: request.Response): string {
  const header = String(res.headers['set-cookie']);
  const match = /pp_session=([^;]+);/.exec(header);
  if (!match?.[1]) throw new Error(`No pp_session cookie in: ${header}`);
  return match[1];
}

async function sql(text: string, params: unknown[]): Promise<void> {
  const client = new Client({ connectionString: testDatabaseUrl() });
  await client.connect();
  try {
    await client.query(text, params);
  } finally {
    await client.end();
  }
}
