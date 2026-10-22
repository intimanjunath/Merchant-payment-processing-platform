import type { InjectedFault, ProviderCallKind } from '@payments/db';
import type { Pool } from 'pg';

/** Test-only fault injection: the fake consumes the oldest matching fault before applying a call. */
export async function injectFault(
  pool: Pool,
  fault: { kind: ProviderCallKind; fault: InjectedFault; chargeId?: string },
): Promise<void> {
  await pool.query(
    `INSERT INTO provider.injected_faults (kind, charge_id, fault) VALUES ($1, $2, $3)`,
    [fault.kind, fault.chargeId ?? null, fault.fault],
  );
}

/** Drops unconsumed faults so one test's leftovers can't fire in the next. */
export async function clearInjectedFaults(pool: Pool): Promise<void> {
  await pool.query('DELETE FROM provider.injected_faults WHERE consumed_at IS NULL');
}
