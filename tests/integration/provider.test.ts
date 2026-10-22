import { randomUUID } from 'node:crypto';

import { createPool } from '@payments/db';
import {
  createFakeProvider,
  type FakeProvider,
  ProviderTimeoutError,
  ProviderUnavailableError,
} from '@payments/provider';
import type { Pool } from 'pg';

import { migrateTestDatabase } from '../helpers/api';
import { clearInjectedFaults, injectFault } from '../helpers/provider';
import { testDatabaseUrl } from '../helpers/test-db';

const TIMEOUT_MS = 100;
const SETTLEMENT_DELAY_MS = 300;
const AMOUNT = 1250;

const newKey = () => `test:${randomUUID()}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('fake provider', () => {
  let pool: Pool;
  let provider: FakeProvider;

  beforeAll(async () => {
    await migrateTestDatabase();
    pool = createPool(testDatabaseUrl(), { applicationName: 'provider-test', max: 20 });
    provider = createFakeProvider(pool, {
      timeoutMs: TIMEOUT_MS,
      settlementDelayMs: SETTLEMENT_DELAY_MS,
    });
    // Open the connections up front. Otherwise the first of several "concurrent"
    // calls finishes while the rest are still connecting, and nothing overlaps.
    const clients = await Promise.all(Array.from({ length: 12 }, () => pool.connect()));
    for (const client of clients) client.release();
  });

  beforeEach(async () => {
    await clearInjectedFaults(pool);
  });

  afterAll(async () => {
    await clearInjectedFaults(pool);
    await pool.end();
  });

  const chargeCount = async () =>
    Number(
      (await pool.query<{ n: string }>('SELECT count(*) AS n FROM provider.charges')).rows[0]?.n,
    );

  const storedRequest = async (providerKey: string) =>
    (
      await pool.query<{ outcome: string; code: string | null }>(
        'SELECT outcome, code FROM provider.requests WHERE provider_key = $1',
        [providerKey],
      )
    ).rows[0];

  const chargeStatus = async (chargeId: string) =>
    (
      await pool.query<{ status: string }>('SELECT status FROM provider.charges WHERE id = $1', [
        chargeId,
      ])
    ).rows[0]?.status;

  /** Authorizes a fresh charge with the given token and returns its ID. */
  async function authorized(token = 'pm_card_visa'): Promise<string> {
    const request = { providerKey: newKey(), token, amountCents: AMOUNT };
    // pm_lost_response times out on the first call; repeating the key returns the stored charge.
    const result =
      token === 'pm_lost_response'
        ? await provider.authorize(request).catch(() => provider.authorize(request))
        : await provider.authorize(request);
    if (result.outcome !== 'succeeded') throw new Error('expected an authorized charge');
    return result.chargeId;
  }

  async function captured(token = 'pm_card_visa'): Promise<string> {
    const chargeId = await authorized(token);
    const result = await provider.capture({ providerKey: newKey(), chargeId, amountCents: AMOUNT });
    if (result.outcome !== 'succeeded') throw new Error('expected a captured charge');
    return chargeId;
  }

  /** Expects the call to time out, and not before the configured timeout. */
  async function expectTimeout(call: () => Promise<unknown>): Promise<void> {
    const started = Date.now();
    await expect(call()).rejects.toBeInstanceOf(ProviderTimeoutError);
    expect(Date.now() - started).toBeGreaterThanOrEqual(TIMEOUT_MS - 5);
  }

  describe('payment methods', () => {
    it.each([
      ['pm_card_visa', 'visa', '4242'],
      ['pm_card_declined', 'visa', '0002'],
      ['pm_timeout', 'mastercard', '4444'],
      ['pm_lost_response', 'amex', '0005'],
    ])('describes %s as %s ending %s', (token, brand, last4) => {
      expect(provider.describePaymentMethod(token)).toEqual({ brand, last4 });
    });

    it('knows nothing else, including card numbers', () => {
      expect(provider.describePaymentMethod('pm_unknown')).toBeNull();
      expect(provider.describePaymentMethod('4242424242424242')).toBeNull();
      expect(provider.describePaymentMethod('constructor')).toBeNull();
    });

    it('returns a copy, so a caller cannot change the token table', () => {
      const described = provider.describePaymentMethod('pm_card_visa');
      if (described) described.last4 = '9999';

      expect(provider.describePaymentMethod('pm_card_visa')?.last4).toBe('4242');
    });
  });

  describe('pm_card_visa', () => {
    it('authorizes, captures, settles after the delay and refunds', async () => {
      const authorizeKey = newKey();
      const authorize = await provider.authorize({
        providerKey: authorizeKey,
        token: 'pm_card_visa',
        amountCents: AMOUNT,
      });
      expect(authorize).toEqual({
        outcome: 'succeeded',
        chargeId: expect.stringMatching(/^ch_[0-9a-f]{24}$/),
      });
      if (authorize.outcome !== 'succeeded') return;
      const { chargeId } = authorize;

      expect(
        await provider.capture({ providerKey: newKey(), chargeId, amountCents: AMOUNT }),
      ).toEqual({
        outcome: 'succeeded',
        chargeId,
      });
      expect(await provider.getSettlement(chargeId)).toEqual({ status: 'pending' });
      await sleep(SETTLEMENT_DELAY_MS + 50);
      expect(await provider.getSettlement(chargeId)).toEqual({ status: 'available' });

      expect(
        await provider.refund({ providerKey: newKey(), chargeId, amountCents: AMOUNT }),
      ).toEqual({
        outcome: 'succeeded',
        chargeId,
      });
      expect(await chargeStatus(chargeId)).toBe('refunded');
      expect(await provider.lookup({ kind: 'authorize', providerKey: authorizeKey })).toEqual({
        outcome: 'succeeded',
        chargeId,
      });
    });
  });

  describe('pm_card_declined', () => {
    it('is declined without creating a charge, and stays declined on replay and lookup', async () => {
      const providerKey = newKey();
      const before = await chargeCount();
      const request = { providerKey, token: 'pm_card_declined', amountCents: AMOUNT };

      expect(await provider.authorize(request)).toEqual({
        outcome: 'rejected',
        code: 'card_declined',
      });
      expect(await provider.authorize(request)).toEqual({
        outcome: 'rejected',
        code: 'card_declined',
      });
      expect(await provider.lookup({ kind: 'authorize', providerKey })).toEqual({
        outcome: 'rejected',
        code: 'card_declined',
      });
      expect(await chargeCount()).toBe(before);
    });
  });

  describe('pm_timeout', () => {
    it('stores nothing and times out; lookup then marks it not received', async () => {
      const providerKey = newKey();
      const before = await chargeCount();

      await expectTimeout(() =>
        provider.authorize({ providerKey, token: 'pm_timeout', amountCents: AMOUNT }),
      );
      expect(await storedRequest(providerKey)).toBeUndefined();

      expect(await provider.lookup({ kind: 'authorize', providerKey })).toEqual({
        outcome: 'not_received',
      });
      expect(await storedRequest(providerKey)).toEqual({ outcome: 'not_received', code: null });
      expect(await chargeCount()).toBe(before);
    });

    it('rejects a late original call after a not-received lookup', async () => {
      const providerKey = newKey();
      const before = await chargeCount();
      expect(await provider.lookup({ kind: 'authorize', providerKey })).toEqual({
        outcome: 'not_received',
      });

      // The original request finally arrives; even a good card must not authorize now.
      for (const token of ['pm_card_visa', 'pm_timeout']) {
        expect(await provider.authorize({ providerKey, token, amountCents: AMOUNT })).toEqual({
          outcome: 'rejected',
          code: 'authorization_not_received',
        });
      }
      expect(await provider.lookup({ kind: 'authorize', providerKey })).toEqual({
        outcome: 'not_received',
      });
      expect(await chargeCount()).toBe(before);
    });
  });

  describe('pm_lost_response', () => {
    it('stores the authorization, then times out; lookup and a repeat find it', async () => {
      const providerKey = newKey();
      const request = { providerKey, token: 'pm_lost_response', amountCents: AMOUNT };

      await expectTimeout(() => provider.authorize(request));
      const found = await provider.lookup({ kind: 'authorize', providerKey });

      expect(found).toEqual({ outcome: 'succeeded', chargeId: expect.stringMatching(/^ch_/) });
      expect(await provider.authorize(request)).toEqual(found);
    });

    it.each(['capture', 'refund'] as const)(
      'stores the %s on the first call per key, then times out',
      async (kind) => {
        const chargeId =
          kind === 'capture' ? await authorized('pm_lost_response') : await capturedLost();
        const providerKey = newKey();
        const request = { providerKey, chargeId, amountCents: AMOUNT };

        await expectTimeout(() => provider[kind](request));
        expect(await provider.lookup({ kind, providerKey })).toEqual({
          outcome: 'succeeded',
          chargeId,
        });
        expect(await provider[kind](request)).toEqual({ outcome: 'succeeded', chargeId });
        expect(await chargeStatus(chargeId)).toBe(kind === 'capture' ? 'captured' : 'refunded');
      },
    );

    /** A pm_lost_response charge captured through a lookup, ready to refund. */
    async function capturedLost(): Promise<string> {
      const chargeId = await authorized('pm_lost_response');
      const providerKey = newKey();
      await expectTimeout(() => provider.capture({ providerKey, chargeId, amountCents: AMOUNT }));
      return chargeId;
    }
  });

  describe('one effect per provider key', () => {
    it('gives ten concurrent authorizations with one key a single charge', async () => {
      const providerKey = newKey();
      const before = await chargeCount();

      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          provider.authorize({ providerKey, token: 'pm_card_visa', amountCents: AMOUNT }),
        ),
      );

      expect(new Set(results.map((result) => JSON.stringify(result))).size).toBe(1);
      expect(results[0]?.outcome).toBe('succeeded');
      expect(await chargeCount()).toBe(before + 1);
    });

    it('gives ten concurrent captures with one key a single capture', async () => {
      const chargeId = await authorized();
      const providerKey = newKey();

      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          provider.capture({ providerKey, chargeId, amountCents: AMOUNT }),
        ),
      );

      expect(results).toEqual(
        Array.from({ length: 10 }, () => ({ outcome: 'succeeded', chargeId })),
      );
      expect(await chargeStatus(chargeId)).toBe('captured');
    });

    it('lets only one of ten captures with different keys succeed', async () => {
      const chargeId = await authorized();

      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          provider.capture({ providerKey: newKey(), chargeId, amountCents: AMOUNT }),
        ),
      );

      expect(results.filter((result) => result.outcome === 'succeeded')).toHaveLength(1);
      expect(results.filter((result) => result.outcome === 'rejected')).toEqual(
        Array.from({ length: 9 }, () => ({ outcome: 'rejected', code: 'charge_not_capturable' })),
      );
    });
  });

  describe('lookup racing authorize', () => {
    it('always ends with one outcome both sides agree on, and no stray charge', async () => {
      const ROUNDS = 60;
      const seen = { authorized: 0, notReceived: 0 };

      for (let round = 0; round < ROUNDS; round += 1) {
        const providerKey = newKey();
        const before = await chargeCount();
        // Authorize does more work before its insert, so starting both at once
        // lets lookup win every time. Delaying lookup by 0, 1 or 2 ms lands it
        // across authorize's window, so both winners and real collisions occur.
        const [lookup, authorize] = await Promise.all([
          sleep(round % 3).then(() => provider.lookup({ kind: 'authorize', providerKey })),
          provider.authorize({ providerKey, token: 'pm_card_visa', amountCents: AMOUNT }),
        ]);
        const after = await chargeCount();

        if (authorize.outcome === 'succeeded') {
          seen.authorized += 1;
          expect(lookup).toEqual(authorize);
          expect(after).toBe(before + 1);
        } else {
          seen.notReceived += 1;
          expect(authorize).toEqual({ outcome: 'rejected', code: 'authorization_not_received' });
          expect(lookup).toEqual({ outcome: 'not_received' });
          expect(after).toBe(before);
        }
        // A later lookup agrees with whichever side won.
        expect(await provider.lookup({ kind: 'authorize', providerKey })).toEqual(lookup);
      }

      expect(seen.authorized + seen.notReceived).toBe(ROUNDS);
      expect(seen.authorized).toBeGreaterThan(0);
      expect(seen.notReceived).toBeGreaterThan(0);
    });
  });

  describe('rejections', () => {
    it('rejects a capture of an unknown charge, a wrong amount, or a second capture', async () => {
      const chargeId = await authorized();

      expect(
        await provider.capture({
          providerKey: newKey(),
          chargeId: 'ch_missing',
          amountCents: AMOUNT,
        }),
      ).toEqual({ outcome: 'rejected', code: 'charge_not_found' });
      expect(
        await provider.capture({ providerKey: newKey(), chargeId, amountCents: AMOUNT + 1 }),
      ).toEqual({
        outcome: 'rejected',
        code: 'amount_mismatch',
      });
      await provider.capture({ providerKey: newKey(), chargeId, amountCents: AMOUNT });
      expect(
        await provider.capture({ providerKey: newKey(), chargeId, amountCents: AMOUNT }),
      ).toEqual({
        outcome: 'rejected',
        code: 'charge_not_capturable',
      });
    });

    it('rejects a refund before capture and a second refund', async () => {
      const authorizedOnly = await authorized();
      const chargeId = await captured();

      expect(
        await provider.refund({
          providerKey: newKey(),
          chargeId: authorizedOnly,
          amountCents: AMOUNT,
        }),
      ).toEqual({ outcome: 'rejected', code: 'charge_not_refundable' });
      await provider.refund({ providerKey: newKey(), chargeId, amountCents: AMOUNT });
      expect(
        await provider.refund({ providerKey: newKey(), chargeId, amountCents: AMOUNT }),
      ).toEqual({
        outcome: 'rejected',
        code: 'charge_not_refundable',
      });
    });

    it('rejects an unknown token', async () => {
      expect(
        await provider.authorize({
          providerKey: newKey(),
          token: 'pm_unknown',
          amountCents: AMOUNT,
        }),
      ).toEqual({ outcome: 'rejected', code: 'unknown_payment_method' });
    });

    it('reports nothing received for a capture or refund it never saw', async () => {
      expect(await provider.lookup({ kind: 'capture', providerKey: newKey() })).toEqual({
        outcome: 'not_received',
      });
      expect(await provider.lookup({ kind: 'refund', providerKey: newKey() })).toEqual({
        outcome: 'not_received',
      });
    });
  });

  describe('injected faults', () => {
    it('times out before the effect; lookup sees nothing and a re-send with the same key succeeds', async () => {
      const chargeId = await authorized();
      const providerKey = newKey();
      await injectFault(pool, { kind: 'capture', fault: 'timeout_before_effect' });

      await expectTimeout(() => provider.capture({ providerKey, chargeId, amountCents: AMOUNT }));
      expect(await provider.lookup({ kind: 'capture', providerKey })).toEqual({
        outcome: 'not_received',
      });
      expect(await chargeStatus(chargeId)).toBe('authorized');

      expect(await provider.capture({ providerKey, chargeId, amountCents: AMOUNT })).toEqual({
        outcome: 'succeeded',
        chargeId,
      });
    });

    it('loses the response after storing the effect', async () => {
      const chargeId = await authorized();
      const providerKey = newKey();
      await injectFault(pool, { kind: 'capture', fault: 'lost_response' });

      await expectTimeout(() => provider.capture({ providerKey, chargeId, amountCents: AMOUNT }));
      expect(await provider.lookup({ kind: 'capture', providerKey })).toEqual({
        outcome: 'succeeded',
        chargeId,
      });
    });

    it('rejects, and keeps the rejection for that key', async () => {
      const chargeId = await captured();
      const providerKey = newKey();
      await injectFault(pool, { kind: 'refund', fault: 'reject' });

      const rejected = { outcome: 'rejected', code: 'rejected_by_provider' };
      expect(await provider.refund({ providerKey, chargeId, amountCents: AMOUNT })).toEqual(
        rejected,
      );
      expect(await provider.refund({ providerKey, chargeId, amountCents: AMOUNT })).toEqual(
        rejected,
      );
      expect(await chargeStatus(chargeId)).toBe('captured');
    });

    it('applies a fault aimed at one charge only to that charge', async () => {
      const target = await authorized();
      const other = await authorized();
      await injectFault(pool, { kind: 'capture', fault: 'reject', chargeId: target });

      expect(
        await provider.capture({ providerKey: newKey(), chargeId: other, amountCents: AMOUNT }),
      ).toEqual({
        outcome: 'succeeded',
        chargeId: other,
      });
      expect(
        await provider.capture({ providerKey: newKey(), chargeId: target, amountCents: AMOUNT }),
      ).toEqual({
        outcome: 'rejected',
        code: 'rejected_by_provider',
      });
    });

    it('uses each fault once, oldest first, and never on a replay', async () => {
      const chargeId = await authorized();
      const providerKey = newKey();
      await injectFault(pool, { kind: 'capture', fault: 'timeout_before_effect' });
      await injectFault(pool, { kind: 'capture', fault: 'lost_response' });

      await expectTimeout(() => provider.capture({ providerKey, chargeId, amountCents: AMOUNT })); // timeout_before_effect
      await expectTimeout(() => provider.capture({ providerKey, chargeId, amountCents: AMOUNT })); // lost_response, stored
      // A replay of the stored key returns at once and leaves the next fault alone.
      await injectFault(pool, { kind: 'capture', fault: 'reject' });
      expect(await provider.capture({ providerKey, chargeId, amountCents: AMOUNT })).toEqual({
        outcome: 'succeeded',
        chargeId,
      });

      const unconsumed = await pool.query<{ fault: string }>(
        'SELECT fault FROM provider.injected_faults WHERE consumed_at IS NULL',
      );
      expect(unconsumed.rows).toEqual([{ fault: 'reject' }]);
    });

    it('does not apply capture faults to authorize', async () => {
      await injectFault(pool, { kind: 'capture', fault: 'reject' });

      expect(
        (
          await provider.authorize({
            providerKey: newKey(),
            token: 'pm_card_visa',
            amountCents: AMOUNT,
          })
        ).outcome,
      ).toBe('succeeded');
    });
  });

  describe('when its storage is unreachable', () => {
    it('reports the provider as unavailable', async () => {
      const closed = createPool(testDatabaseUrl(), { applicationName: 'provider-closed', max: 1 });
      await closed.end();
      const unreachable = createFakeProvider(closed, {
        timeoutMs: TIMEOUT_MS,
        settlementDelayMs: 0,
      });

      await expect(
        unreachable.authorize({
          providerKey: newKey(),
          token: 'pm_card_visa',
          amountCents: AMOUNT,
        }),
      ).rejects.toBeInstanceOf(ProviderUnavailableError);
      await expect(
        unreachable.lookup({ kind: 'authorize', providerKey: newKey() }),
      ).rejects.toBeInstanceOf(ProviderUnavailableError);
    });

    it('treats an unknown charge in a settlement check as a failure, not as pending', async () => {
      await expect(provider.getSettlement('ch_missing')).rejects.toBeInstanceOf(
        ProviderUnavailableError,
      );
    });
  });
});
