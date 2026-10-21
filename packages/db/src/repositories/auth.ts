import type { Pool, PoolClient } from 'pg';

type Db = Pool | PoolClient;

export type ClientKind = 'browser' | 'api';

export interface MerchantRecord {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
}

export interface Merchant {
  id: string;
  email: string;
  name: string;
}

export interface ActiveSession {
  id: string;
  clientKind: ClientKind;
  expiresAt: Date;
  merchant: Merchant;
}

export async function findMerchantByEmail(
  db: Db,
  email: string,
): Promise<MerchantRecord | undefined> {
  const result = await db.query<MerchantRecord>(
    `SELECT id, email, name, password_hash AS "passwordHash"
       FROM merchants
      WHERE lower(email) = lower($1)`,
    [email],
  );
  return result.rows[0];
}

export async function createSession(
  db: Db,
  session: { merchantId: string; clientKind: ClientKind; ttlSeconds: number },
): Promise<{ id: string; expiresAt: Date }> {
  const result = await db.query<{ id: string; expiresAt: Date }>(
    `INSERT INTO sessions (merchant_id, client_kind, expires_at)
     VALUES ($1, $2, now() + make_interval(secs => $3))
     RETURNING id, expires_at AS "expiresAt"`,
    [session.merchantId, session.clientKind, session.ttlSeconds],
  );
  const row = result.rows[0];
  if (!row) throw new Error('INSERT INTO sessions returned no row');
  return row;
}

/** A session that exists, belongs to `merchantId`, is not revoked and has not expired. */
export async function findActiveSession(
  db: Db,
  ids: { sessionId: string; merchantId: string },
): Promise<ActiveSession | undefined> {
  const result = await db.query<{
    id: string;
    clientKind: ClientKind;
    expiresAt: Date;
    merchantId: string;
    email: string;
    name: string;
  }>(
    `SELECT s.id, s.client_kind AS "clientKind", s.expires_at AS "expiresAt",
            m.id AS "merchantId", m.email, m.name
       FROM sessions s
       JOIN merchants m ON m.id = s.merchant_id
      WHERE s.id = $1
        AND s.merchant_id = $2
        AND s.revoked_at IS NULL
        AND s.expires_at > now()`,
    [ids.sessionId, ids.merchantId],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  return {
    id: row.id,
    clientKind: row.clientKind,
    expiresAt: row.expiresAt,
    merchant: { id: row.merchantId, email: row.email, name: row.name },
  };
}

/** Returns false if the session was already revoked. */
export async function revokeSession(db: Db, sessionId: string): Promise<boolean> {
  const result = await db.query(
    'UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
    [sessionId],
  );
  return result.rowCount === 1;
}
