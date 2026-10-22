import { useEffect, useState, useSyncExternalStore } from 'react';

import { type DetailsState, PaymentDetailsController } from './payment-details-controller';
import { useSession } from './use-session';

/**
 * One payment's details, polled while unresolved (PaymentDetailsController).
 * Mount it once per payment ID (key the component by the ID): the controller
 * belongs to that payment.
 */
export function usePaymentDetails(paymentId: string): {
  state: DetailsState;
  refresh: () => void;
} {
  const { api } = useSession();
  const [controller] = useState(
    () =>
      new PaymentDetailsController(paymentId, {
        api,
        timers: {
          setTimeout: (callback, ms) => window.setTimeout(callback, ms),
          clearTimeout: (handle) => {
            window.clearTimeout(handle as number);
          },
        },
        isVisible: () => document.visibilityState === 'visible',
      }),
  );
  const state = useSyncExternalStore(controller.subscribe, controller.getState);

  useEffect(() => {
    controller.start();
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') controller.visible();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      controller.dispose();
    };
  }, [controller]);

  return {
    state,
    refresh: () => {
      controller.refresh();
    },
  };
}
