import { recoverOperation, type RecoveryDeps } from '@payments/payments';

import type { JobHandler } from '../worker';

/** operation_recovery jobs: all decisions are made by recoverOperation in packages/payments. */
export function recoveryHandler(deps: RecoveryDeps): JobHandler {
  return async (job, run) => {
    await recoverOperation(deps, job, run);
  };
}
