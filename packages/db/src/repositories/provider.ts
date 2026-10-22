import type { Pool, PoolClient } from 'pg';

type Db = Pool | PoolClient;

// Tables of the fake provider (migration 003). They live in their own schema
// with no foreign keys to the application, like an external system would.

export type ProviderCallKind = 'authorize' | 'capture' | 'refund';
export type StoredOutcome = 'succeeded' | 'declined' | 'rejected' | 'not_received';
export type InjectedFault = 'timeout_before_effect' | 'lost_response' | 'reject';
export type ChargeStatus = 'authorized' | 'captured' | 'refunded';

export interface ProviderRequestRow {
  providerKey: string;
  kind: ProviderCallKind;
  chargeId: string | null;
  outcome: StoredOutcome;
  code: string | null;
}

export interface ChargeRow {
  id: string;
  token: string;
  amountCents: number;
  status: ChargeStatus;
}

export async function findProviderRequest(
  db: Db,
  providerKey: string,
): Promise<ProviderRequestRow | undefined> {
  const result = await db.query<ProviderRequestRow>(
    `SELECT provider_key AS "providerKey", kind, charge_id AS "chargeId", outcome, code
       FROM provider.requests
      WHERE provider_key = $1`,
    [providerKey],
  );
  return result.rows[0];
}

/**
 * Stores the outcome for a provider key unless one is already stored. Returns
 * false when the key was taken; a concurrent insert of the same key waits for
 * the other transaction and then reports the conflict.
 */
export async function insertProviderRequest(db: Db, row: ProviderRequestRow): Promise<boolean> {
  const result = await db.query(
    `INSERT INTO provider.requests (provider_key, kind, charge_id, outcome, code)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (provider_key) DO NOTHING`,
    [row.providerKey, row.kind, row.chargeId, row.outcome, row.code],
  );
  return result.rowCount === 1;
}

export async function insertCharge(
  db: Db,
  charge: { id: string; token: string; amountCents: number },
): Promise<void> {
  await db.query(
    `INSERT INTO provider.charges (id, token, amount_cents, status) VALUES ($1, $2, $3, 'authorized')`,
    [charge.id, charge.token, charge.amountCents],
  );
}

/** Locks the charge for the rest of the transaction, so one capture or refund applies at a time. */
export async function lockCharge(db: Db, chargeId: string): Promise<ChargeRow | undefined> {
  const result = await db.query<ChargeRow>(
    `SELECT id, token, amount_cents::float8 AS "amountCents", status
       FROM provider.charges
      WHERE id = $1
        FOR UPDATE`,
    [chargeId],
  );
  return result.rows[0];
}

export async function markChargeCaptured(
  db: Db,
  chargeId: string,
  settlementDelayMs: number,
): Promise<void> {
  await db.query(
    `UPDATE provider.charges
        SET status = 'captured',
            captured_at = now(),
            funds_available_at = now() + make_interval(secs => $2::float8 / 1000)
      WHERE id = $1`,
    [chargeId, settlementDelayMs],
  );
}

export async function markChargeRefunded(db: Db, chargeId: string): Promise<void> {
  await db.query(
    `UPDATE provider.charges SET status = 'refunded', refunded_at = now() WHERE id = $1`,
    [chargeId],
  );
}

/** Records that an authorization never arrived, unless something is already stored for the key. */
export async function insertAuthorizeNotReceived(db: Db, providerKey: string): Promise<void> {
  await db.query(
    `INSERT INTO provider.requests (provider_key, kind, outcome)
     VALUES ($1, 'authorize', 'not_received')
     ON CONFLICT (provider_key) DO NOTHING`,
    [providerKey],
  );
}

/**
 * Takes the oldest unconsumed fault for this kind of call, if any. A fault
 * with no charge matches every charge; for authorize there is no charge yet,
 * so only those match.
 */
export async function consumeInjectedFault(
  db: Db,
  kind: ProviderCallKind,
  chargeId: string | null,
): Promise<InjectedFault | undefined> {
  const result = await db.query<{ fault: InjectedFault }>(
    `UPDATE provider.injected_faults
        SET consumed_at = now()
      WHERE id = (SELECT id
                    FROM provider.injected_faults
                   WHERE kind = $1
                     AND consumed_at IS NULL
                     AND (charge_id IS NULL OR charge_id = $2)
                   ORDER BY id
                   LIMIT 1
                     FOR UPDATE SKIP LOCKED)
      RETURNING fault`,
    [kind, chargeId],
  );
  return result.rows[0]?.fault;
}

/** Whether the charge's funds are available, judged by the database clock. */
export async function readSettlement(
  db: Db,
  chargeId: string,
): Promise<{ available: boolean } | undefined> {
  const result = await db.query<{ available: boolean }>(
    `SELECT coalesce(funds_available_at <= now(), false) AS available
       FROM provider.charges
      WHERE id = $1`,
    [chargeId],
  );
  return result.rows[0];
}
