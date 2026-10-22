import { settlePayment, type SettlementDeps } from '@payments/payments';

import type { JobHandler } from '../worker';

/** settlement jobs: all decisions are made by settlePayment in packages/payments. */
export function settlementHandler(deps: SettlementDeps): JobHandler {
  return async (job, run) => {
    await settlePayment(deps, job, run);
  };
}
