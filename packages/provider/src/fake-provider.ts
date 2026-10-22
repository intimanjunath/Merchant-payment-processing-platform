import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  consumeInjectedFault,
  findProviderRequest,
  insertAuthorizeNotReceived,
  insertCharge,
  insertProviderRequest,
  lockCharge,
  markChargeCaptured,
  markChargeRefunded,
  type ProviderRequestRow,
  readSettlement,
  withTransaction,
} from '@payments/db';
import type { Pool, PoolClient } from 'pg';

import {
  type LookupResult,
  type PaymentProvider,
  type ProviderCallKind,
  type ProviderResult,
  ProviderTimeoutError,
  ProviderUnavailableError,
} from './contract';
import { isTestToken, TEST_TOKENS } from './test-tokens';

export interface FakeProviderOptions {
  /** How long a call that "times out" waits before throwing (PROVIDER_TIMEOUT_MS). */
  timeoutMs: number;
  /** Delay from capture until funds are available (SETTLEMENT_DELAY_MS). */
  settlementDelayMs: number;
}

/** What a call decided, before it is stored under its provider key. */
interface Decision {
  outcome: ProviderRequestRow['outcome'];
  code: string | null;
  chargeId: string | null;
  /** pm_lost_response: store the effect, then time out. */
  loseResponse: boolean;
}

/** Another call stored an outcome for this key first; the transaction is rolled back. */
class KeyAlreadyStored extends Error {}

/**
 * A provider backed by its own PostgreSQL schema, so its effects survive
 * application crashes the way a real provider's would. Each provider key gets
 * one row in provider.requests; the primary key makes concurrent calls with
 * one key produce one effect, and serializes authorize against the
 * not-received marker written by lookup.
 */
export class FakeProvider implements PaymentProvider {
  constructor(
    private readonly pool: Pool,
    private readonly options: FakeProviderOptions,
  ) {}

  describePaymentMethod(token: string): { brand: string; last4: string } | null {
    return isTestToken(token) ? { ...TEST_TOKENS[token] } : null;
  }

  authorize(req: { providerKey: string; token: string; amountCents: number }) {
    return this.call('authorize', req.providerKey, null, req.token === 'pm_timeout', async (db) => {
      if (!isTestToken(req.token)) return reject('declined', 'unknown_payment_method', null);
      if (req.token === 'pm_card_declined') return reject('declined', 'card_declined', null);

      const chargeId = `ch_${randomBytes(12).toString('hex')}`;
      await insertCharge(db, { id: chargeId, token: req.token, amountCents: req.amountCents });
      return succeed(chargeId, req.token === 'pm_lost_response');
    });
  }

  capture(req: { providerKey: string; chargeId: string; amountCents: number }) {
    return this.call('capture', req.providerKey, req.chargeId, false, async (db) => {
      const charge = await lockCharge(db, req.chargeId);
      if (!charge) return reject('rejected', 'charge_not_found', null);
      const lose = charge.token === 'pm_lost_response';
      if (charge.status !== 'authorized')
        return reject('rejected', 'charge_not_capturable', charge.id, lose);
      if (charge.amountCents !== req.amountCents)
        return reject('rejected', 'amount_mismatch', charge.id, lose);

      await markChargeCaptured(db, charge.id, this.options.settlementDelayMs);
      return succeed(charge.id, lose);
    });
  }

  refund(req: { providerKey: string; chargeId: string; amountCents: number }) {
    return this.call('refund', req.providerKey, req.chargeId, false, async (db) => {
      const charge = await lockCharge(db, req.chargeId);
      if (!charge) return reject('rejected', 'charge_not_found', null);
      const lose = charge.token === 'pm_lost_response';
      if (charge.status !== 'captured')
        return reject('rejected', 'charge_not_refundable', charge.id, lose);
      if (charge.amountCents !== req.amountCents)
        return reject('rejected', 'amount_mismatch', charge.id, lose);

      await markChargeRefunded(db, charge.id);
      return succeed(charge.id, lose);
    });
  }

  /**
   * For authorize, a missing record is marked not_received in the same step,
   * so a late original call can no longer authorize. For capture and refund
   * the lookup only reads, and the caller re-sends with the same key.
   */
  lookup(req: { kind: ProviderCallKind; providerKey: string }): Promise<LookupResult> {
    return this.unlessUnavailable(async () => {
      const row =
        req.kind === 'authorize'
          ? await withTransaction(this.pool, async (client) => {
              await insertAuthorizeNotReceived(client, req.providerKey);
              return findProviderRequest(client, req.providerKey);
            })
          : await findProviderRequest(this.pool, req.providerKey);
      if (!row || row.outcome === 'not_received') return { outcome: 'not_received' };
      return toResult(row);
    });
  }

  getSettlement(chargeId: string): Promise<{ status: 'pending' | 'available' }> {
    return this.unlessUnavailable(async () => {
      const settlement = await readSettlement(this.pool, chargeId);
      if (!settlement) throw new Error('Unknown charge');
      return { status: settlement.available ? 'available' : 'pending' };
    });
  }

  /**
   * The shared path of authorize, capture and refund:
   * 1. a key with a stored outcome returns it, with no new effect and no fault consumed;
   * 2. a call that never arrives (pm_timeout, or an injected timeout) stores nothing and times out;
   * 3. otherwise the decision and its effect commit together with the key's row;
   * 4. a lost response (pm_lost_response, or an injected one) times out after the commit.
   */
  private call(
    kind: ProviderCallKind,
    providerKey: string,
    chargeId: string | null,
    neverArrives: boolean,
    decide: (db: PoolClient) => Promise<Decision>,
  ): Promise<ProviderResult> {
    return this.unlessUnavailable(async () => {
      const existing = await findProviderRequest(this.pool, providerKey);
      if (existing) return toResult(existing);
      if (neverArrives) return this.timeOut();

      const fault = await consumeInjectedFault(this.pool, kind, chargeId);
      if (fault === 'timeout_before_effect') return this.timeOut();

      const { row, created, loseResponse } = await this.store(
        kind,
        providerKey,
        fault === 'reject'
          ? () => Promise.resolve(reject('rejected', 'rejected_by_provider', chargeId))
          : decide,
      );
      if (created && (loseResponse || fault === 'lost_response')) return this.timeOut();
      return toResult(row);
    });
  }

  private async store(
    kind: ProviderCallKind,
    providerKey: string,
    decide: (db: PoolClient) => Promise<Decision>,
  ): Promise<{ row: ProviderRequestRow; created: boolean; loseResponse: boolean }> {
    try {
      return await withTransaction(this.pool, async (client) => {
        const { loseResponse, ...decision } = await decide(client);
        const row: ProviderRequestRow = { providerKey, kind, ...decision };
        if (!(await insertProviderRequest(client, row))) throw new KeyAlreadyStored();
        return { row, created: true, loseResponse };
      });
    } catch (error) {
      if (!(error instanceof KeyAlreadyStored)) throw error;
      const row = await findProviderRequest(this.pool, providerKey);
      if (!row) {
        throw new Error('Provider request disappeared after a key conflict', { cause: error });
      }
      return { row, created: false, loseResponse: false };
    }
  }

  private async timeOut(): Promise<never> {
    await sleep(this.options.timeoutMs);
    throw new ProviderTimeoutError();
  }

  /** Any failure of the fake's own storage looks like an unreachable provider. */
  private async unlessUnavailable<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ProviderTimeoutError) throw error;
      throw new ProviderUnavailableError(error);
    }
  }
}

export function createFakeProvider(pool: Pool, options: FakeProviderOptions): FakeProvider {
  return new FakeProvider(pool, options);
}

function succeed(chargeId: string, loseResponse: boolean): Decision {
  return { outcome: 'succeeded', code: null, chargeId, loseResponse };
}

function reject(
  outcome: 'declined' | 'rejected',
  code: string,
  chargeId: string | null,
  loseResponse = false,
): Decision {
  return { outcome, code, chargeId, loseResponse };
}

/** A stored row as a call result. A not_received authorize means the original call came too late. */
function toResult(row: ProviderRequestRow): ProviderResult {
  if (row.outcome === 'succeeded' && row.chargeId) {
    return { outcome: 'succeeded', chargeId: row.chargeId };
  }
  if (row.outcome === 'not_received') {
    return { outcome: 'rejected', code: 'authorization_not_received' };
  }
  return { outcome: 'rejected', code: row.code ?? 'rejected' };
}
