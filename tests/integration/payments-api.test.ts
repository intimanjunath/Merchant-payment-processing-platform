import { randomUUID } from 'node:crypto';

import { createPool } from '@payments/db';
import type { Pool } from 'pg';
import request, { type Response } from 'supertest';

import { OPENAPI_DOCUMENT } from '../../apps/api/src/payments/openapi';
import {
  clearLoginAttempts,
  migrateTestDatabase,
  SEEDED_MERCHANTS,
  startTestApi,
  type TestApi,
} from '../helpers/api';
import { compileAllSchemas, conforms, routeLists } from '../helpers/openapi';
import { clearInjectedFaults, injectFault } from '../helpers/provider';
import { testDatabaseUrl } from '../helpers/test-db';

const { acme, bicycle } = SEEDED_MERCHANTS;
const CARD_NUMBER = '4242424242424242';

describe('payment API', () => {
  let api: TestApi;
  let db: Pool;
  let acmeToken: string;
  let bicycleToken: string;
  const server = () => api.app.getHttpServer();

  beforeAll(async () => {
    await migrateTestDatabase({ seed: true });
    await clearLoginAttempts();
    api = await startTestApi({ poolMax: 6 });
    db = createPool(testDatabaseUrl(), { applicationName: 'payments-api-test', max: 2 });
    const tokenFor = async (merchant: typeof acme) =>
      String(
        (
          await request(server())
            .post('/auth/token')
            .send({ email: merchant.email, password: merchant.password })
            .expect(200)
        ).body.accessToken,
      );
    acmeToken = await tokenFor(acme);
    bicycleToken = await tokenFor(bicycle);
  });

  beforeEach(async () => {
    await clearInjectedFaults(db);
  });

  afterAll(async () => {
    await clearInjectedFaults(db);
    await db.end();
    await api.app.close();
  });

  const newKey = () => `key-${randomUUID()}`;
  const order = (paymentMethod = 'pm_card_visa', overrides: Record<string, unknown> = {}) => ({
    amount: 1500,
    reference: `order-${randomUUID()}`,
    paymentMethod,
    ...overrides,
  });

  async function create(
    body: object,
    options: { key?: string; token?: string; requestId?: string } = {},
  ): Promise<Response> {
    const req = request(server())
      .post('/payments')
      .set('Authorization', `Bearer ${options.token ?? acmeToken}`)
      .set('Idempotency-Key', options.key ?? newKey());
    if (options.requestId) req.set('X-Request-Id', options.requestId);
    return conforms(await req.send(body), 'post', '/payments');
  }

  async function act(
    action: 'capture' | 'refund',
    paymentId: string,
    options: { key?: string; token?: string; requestId?: string; body?: object } = {},
  ): Promise<Response> {
    const req = request(server())
      .post(`/payments/${paymentId}/${action}`)
      .set('Authorization', `Bearer ${options.token ?? acmeToken}`)
      .set('Idempotency-Key', options.key ?? newKey());
    if (options.requestId) req.set('X-Request-Id', options.requestId);
    return conforms(await req.send(options.body ?? {}), 'post', `/payments/{id}/${action}`);
  }

  async function details(paymentId: string, token = acmeToken): Promise<Response> {
    return conforms(
      await request(server()).get(`/payments/${paymentId}`).set('Authorization', `Bearer ${token}`),
      'get',
      '/payments/{id}',
    );
  }

  async function authorizedPaymentId(): Promise<string> {
    const res = await create(order());
    expect(res.status).toBe(201);
    return String(res.body.payment.id);
  }

  const chargeOf = async (paymentId: string) =>
    (
      await db.query<{ provider_payment_id: string }>(
        'SELECT provider_payment_id FROM payments WHERE id = $1',
        [paymentId],
      )
    ).rows[0]?.provider_payment_id ?? '';

  describe('POST /payments', () => {
    it('answers 201 for an approved payment, with Location and no-store', async () => {
      const res = await create(order());

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        payment: {
          state: 'authorized',
          amount: 1500,
          currency: 'USD',
          paymentMethod: { brand: 'visa', last4: '4242' },
          failureReason: null,
          settlementReview: false,
        },
        operation: { action: 'authorize', status: 'succeeded', reason: null },
      });
      expect(res.headers.location).toBe(`/payments/${String(res.body.payment.id)}`);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(JSON.stringify(res.body)).not.toContain('pm_card_visa');
    });

    it('answers 201 for a decline: the payment exists, Failed, with card_declined', async () => {
      const res = await create(order('pm_card_declined'));

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        payment: { state: 'failed', failureReason: 'card_declined' },
        operation: { status: 'rejected', reason: 'card_declined' },
      });
    });

    it.each(['pm_timeout', 'pm_lost_response'])(
      'answers 202 for %s, with the unresolved operation and Location',
      async (token) => {
        const res = await create(order(token));

        expect(res.status).toBe(202);
        expect(res.body).toMatchObject({
          payment: { state: 'pending' },
          operation: {
            status: 'awaiting_confirmation',
            reason: 'provider_timeout',
            completedAt: null,
          },
        });
        expect(res.headers.location).toBe(`/payments/${String(res.body.payment.id)}`);
      },
    );

    it('replays the same key and body with the original status and body', async () => {
      const key = newKey();
      const body = order();
      const first = await create(body, { key });

      const again = await create(
        { paymentMethod: body.paymentMethod, reference: ` ${body.reference} `, amount: 1500 },
        { key },
      );

      expect(again.status).toBe(201);
      expect(again.body).toEqual(first.body);
    });

    it('answers 409 IDEMPOTENCY_CONFLICT for the same key with a different body', async () => {
      const key = newKey();
      await create(order(), { key });

      const res = await create(order('pm_card_visa', { amount: 1600 }), { key });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it.each([
      ['no key', undefined],
      ['a key with a space', 'has space'],
      ['a key over 128 characters', 'k'.repeat(129)],
    ])('answers 400 for %s', async (_label, key) => {
      const req = request(server()).post('/payments').set('Authorization', `Bearer ${acmeToken}`);
      if (key !== undefined) req.set('Idempotency-Key', key);
      const res = conforms(await req.send(order()), 'post', '/payments');

      expect(res.status).toBe(400);
      expect(res.body.error.details.fields).toEqual([
        expect.objectContaining({ field: 'Idempotency-Key' }),
      ]);
    });

    it.each([
      ['a zero amount', { amount: 0 }, 'amount'],
      ['an amount over the limit', { amount: 100_000_001 }, 'amount'],
      ['an amount sent as a string', { amount: '1500' }, 'amount'],
      ['a fractional amount', { amount: 15.5 }, 'amount'],
      ['a blank reference', { reference: '   ' }, 'reference'],
      ['a reference over 100 characters', { reference: 'r'.repeat(101) }, 'reference'],
      ['an unknown payment method', { paymentMethod: 'pm_unknown' }, 'paymentMethod'],
    ])('answers 400 VALIDATION_ERROR for %s', async (_label, change, field) => {
      const res = await create(order('pm_card_visa', change));

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details.fields).toEqual(
        expect.arrayContaining([expect.objectContaining({ field })]),
      );
    });

    it('refuses card data in any form without echoing it back', async () => {
      const asField = await create({ ...order(), cardNumber: CARD_NUMBER, cvv: '123' });
      const asMethod = await create(order(CARD_NUMBER));

      expect(asField.status).toBe(400);
      expect(asField.body.error.details.fields).toEqual([
        { field: 'cardNumber', issue: 'is not an accepted field' },
        { field: 'cvv', issue: 'is not an accepted field' },
      ]);
      expect(asMethod.status).toBe(400);
      for (const res of [asField, asMethod])
        expect(JSON.stringify(res.body)).not.toContain(CARD_NUMBER);
      expect(JSON.stringify(api.logs)).not.toContain(CARD_NUMBER);
    });
  });

  describe('capture and refund', () => {
    it('captures with 200, then refuses a second capture with 409 INVALID_STATE_TRANSITION', async () => {
      const paymentId = await authorizedPaymentId();

      const captured = await act('capture', paymentId);
      const again = await act('capture', paymentId);

      expect(captured.status).toBe(200);
      expect(captured.body).toMatchObject({
        payment: { state: 'captured' },
        operation: { status: 'succeeded' },
      });
      expect(captured.headers.location).toBeUndefined();
      expect(again.status).toBe(409);
      expect(again.body.error).toMatchObject({
        code: 'INVALID_STATE_TRANSITION',
        details: { state: 'captured' },
      });
    });

    it('refuses a refund before settlement with 409, and refunds a settled payment with 200', async () => {
      const paymentId = await authorizedPaymentId();
      await act('capture', paymentId);

      expect((await act('refund', paymentId)).status).toBe(409);
      await db.query(`UPDATE payments SET state = 'settled', version = version + 1 WHERE id = $1`, [
        paymentId,
      ]);
      const refunded = await act('refund', paymentId);

      expect(refunded.status).toBe(200);
      expect(refunded.body.payment.state).toBe('refunded');
    });

    it('answers 422 PROVIDER_REJECTED with this request’s ID, keeps the state, and replays it', async () => {
      const paymentId = await authorizedPaymentId();
      await injectFault(db, {
        kind: 'capture',
        fault: 'reject',
        chargeId: await chargeOf(paymentId),
      });
      const key = newKey();

      const res = await act('capture', paymentId, { key, requestId: 'req-reject-1' });
      const replay = await act('capture', paymentId, { key, requestId: 'req-reject-2' });

      expect(res.status).toBe(422);
      expect(res.body.error).toEqual({
        code: 'PROVIDER_REJECTED',
        message: 'The payment provider rejected the request.',
        requestId: 'req-reject-1',
        details: { paymentId, operationId: expect.any(String), code: 'rejected_by_provider' },
      });
      expect(replay.status).toBe(422);
      expect(replay.body.error).toEqual({ ...res.body.error, requestId: 'req-reject-2' });
      expect((await details(paymentId)).body.payment.state).toBe('authorized');
    });

    it('answers 409 OPERATION_IN_PROGRESS while the create is unresolved', async () => {
      const pending = await create(order('pm_lost_response'));

      const res = await act('capture', String(pending.body.payment.id));

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('OPERATION_IN_PROGRESS');
    });

    it('refuses a body on capture', async () => {
      const paymentId = await authorizedPaymentId();

      const res = await act('capture', paymentId, { body: { amount: 1 } });

      expect(res.status).toBe(400);
      expect(res.body.error.details.fields).toEqual([
        { field: 'amount', issue: 'is not an accepted field' },
      ]);
      expect((await details(paymentId)).body.payment.state).toBe('authorized');
    });
  });

  describe('merchant isolation', () => {
    it("answers 404 for another merchant's payment on every route", async () => {
      const paymentId = await authorizedPaymentId();

      expect((await details(paymentId, bicycleToken)).status).toBe(404);
      expect((await act('capture', paymentId, { token: bicycleToken })).status).toBe(404);
      expect((await act('refund', paymentId, { token: bicycleToken })).status).toBe(404);
      expect((await details(paymentId)).body.payment.state).toBe('authorized');
    });

    it('answers 404 for a missing or malformed ID, and finds an uppercase spelling', async () => {
      const paymentId = await authorizedPaymentId();

      expect((await details(randomUUID())).status).toBe(404);
      expect((await details('not-a-uuid')).status).toBe(404);
      expect((await act('capture', 'not-a-uuid')).status).toBe(404);
      expect((await details(paymentId.toUpperCase())).body.payment.id).toBe(paymentId);
    });
  });

  describe('GET /payments/{id}', () => {
    it('shows operations and transitions oldest first, with their request IDs', async () => {
      const created = await create(order(), { requestId: 'req-create' });
      const paymentId = String(created.body.payment.id);
      await act('capture', paymentId, { requestId: 'req-capture' });

      const res = await details(paymentId);

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const body = res.body as {
        pendingOperation: unknown;
        operations: { action: string; status: string }[];
        transitions: { fromState: string | null; toState: string; requestId: string }[];
      };
      expect(body.pendingOperation).toBeNull();
      expect(body.operations.map((op) => [op.action, op.status])).toEqual([
        ['authorize', 'succeeded'],
        ['capture', 'succeeded'],
      ]);
      expect(body.transitions.map((t) => [t.fromState, t.toState, t.requestId])).toEqual([
        [null, 'pending', 'req-create'],
        ['pending', 'authorized', 'req-create'],
        ['authorized', 'captured', 'req-capture'],
      ]);
    });

    it('shows the unresolved operation as pending', async () => {
      const created = await create(order('pm_timeout'));

      const res = await details(String(created.body.payment.id));

      expect(res.body.pendingOperation).toMatchObject({
        id: created.body.operation.id,
        status: 'awaiting_confirmation',
      });
    });
  });

  describe('authentication', () => {
    it('answers 401 without a credential on every payment route', async () => {
      const id = randomUUID();
      const responses = [
        conforms(await request(server()).post('/payments').send(order()), 'post', '/payments'),
        conforms(await request(server()).get(`/payments/${id}`), 'get', '/payments/{id}'),
        conforms(
          await request(server()).post(`/payments/${id}/capture`),
          'post',
          '/payments/{id}/capture',
        ),
        conforms(
          await request(server()).post(`/payments/${id}/refund`),
          'post',
          '/payments/{id}/refund',
        ),
      ];

      for (const res of responses) expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('needs the CSRF token for a cookie-authenticated create', async () => {
      const login = await request(server())
        .post('/auth/login')
        .send({ email: acme.email, password: acme.password })
        .expect(200);
      const cookie = /pp_session=[^;]+/.exec(String(login.headers['set-cookie']))?.[0] ?? '';
      const send = (csrf?: string) => {
        const req = request(server())
          .post('/payments')
          .set('Cookie', cookie)
          .set('Idempotency-Key', newKey());
        if (csrf) req.set('X-CSRF-Token', csrf);
        return req.send(order());
      };

      const without = conforms(await send(), 'post', '/payments');
      const withToken = conforms(await send(String(login.body.csrfToken)), 'post', '/payments');

      expect(without.status).toBe(403);
      expect(without.body.error.code).toBe('CSRF_REJECTED');
      expect(withToken.status).toBe(201);
    });
  });

  describe('when the database is unreachable', () => {
    it('answers 503 SERVICE_UNAVAILABLE', async () => {
      const unreachable = await startTestApi({
        databaseUrl: 'postgres://nobody:nothing@127.0.0.1:1/none',
      });
      try {
        const res = conforms(
          await request(unreachable.app.getHttpServer())
            .post('/payments')
            .set('Authorization', `Bearer ${acmeToken}`)
            .set('Idempotency-Key', newKey())
            .send(order()),
          'post',
          '/payments',
        );

        expect(res.status).toBe(503);
        expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
      } finally {
        await unreachable.app.close();
      }
    });
  });

  describe('OpenAPI', () => {
    it('serves the document', async () => {
      const res = await request(server()).get('/openapi.json').expect(200);

      expect(res.body).toEqual(JSON.parse(JSON.stringify(OPENAPI_DOCUMENT)));
    });

    it('documents every route the API has, and no route it lacks', () => {
      const { registered, documented } = routeLists(api.app);

      expect(documented).toEqual(registered);
    });

    it('has schemas that compile as strict JSON Schema 2020-12', () => {
      expect(compileAllSchemas()).toEqual(Object.keys(OPENAPI_DOCUMENT.components.schemas));
    });
  });

  it('never logs payment-method tokens, card numbers or bearer tokens', () => {
    const text = JSON.stringify(api.logs);

    expect(text).not.toMatch(/pm_(card|timeout|lost)/);
    expect(text).not.toContain(CARD_NUMBER);
    expect(text).not.toContain(acmeToken);
  });
});
