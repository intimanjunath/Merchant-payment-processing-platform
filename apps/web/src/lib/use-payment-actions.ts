import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { type ActionsState, PaymentActionsController } from './payment-actions-controller';
import { PendingActions } from './pending-actions';
import type { PaymentDetails } from './payments';
import { useSession } from './use-session';

/** The signed-in merchant's pending actions. Only for pages behind sign-in. */
export function usePendingStore(): PendingActions {
  const { state } = useSession();
  const merchantId = state.status === 'signed_in' ? state.merchant.id : null;
  return useMemo(() => {
    if (!merchantId) throw new Error('usePendingStore needs a signed-in merchant');
    return new PendingActions(window.sessionStorage, merchantId);
  }, [merchantId]);
}

/**
 * Capture and refund for one payment (PaymentActionsController), fed with
 * every details answer so an action left pending resumes on its own.
 */
export function usePaymentActions(
  paymentId: string,
  details: PaymentDetails | null,
  refresh: () => void,
): { state: ActionsState; start: (kind: 'capture' | 'refund') => void; retry: () => void } {
  const { api } = useSession();
  const store = usePendingStore();
  const [controller] = useState(
    () =>
      new PaymentActionsController(paymentId, {
        api,
        store,
        newKey: () => crypto.randomUUID(),
        now: () => new Date(),
        onSettled: refresh,
      }),
  );
  const state = useSyncExternalStore(controller.subscribe, controller.getState);

  useEffect(() => {
    controller.activate();
    return () => {
      controller.dispose();
    };
  }, [controller]);

  useEffect(() => {
    if (details) controller.detailsChanged(details);
  }, [controller, details]);

  return {
    state,
    start: (kind) => {
      controller.start(kind);
    },
    retry: () => {
      controller.retry();
    },
  };
}
