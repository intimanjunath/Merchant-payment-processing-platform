import { useEffect, useState, useSyncExternalStore } from 'react';

import {
  filterKeyOf,
  type ListFilters,
  type ListState,
  PaymentListController,
} from './payment-list-controller';
import { useSession } from './use-session';

export interface PaymentList {
  state: ListState;
  older: () => void;
  newer: () => void;
  retry: () => void;
}

/**
 * Binds a PaymentListController to the filters in the URL. Until the
 * controller has caught up with new filters (its effect runs after the
 * render), the page sees placeholders, never the previous filters' rows.
 */
export function usePaymentList(filters: ListFilters): PaymentList {
  const { api } = useSession();
  const [controller] = useState(() => new PaymentListController(api));
  const stored = useSyncExternalStore(controller.subscribe, controller.getState);
  const filterKey = filterKeyOf(filters);
  const { status, q, limit } = filters;

  useEffect(() => {
    controller.setFilters({ status, q, limit });
  }, [controller, status, q, limit]);

  useEffect(
    () => () => {
      controller.dispose();
    },
    [controller],
  );

  const state: ListState =
    stored.filterKey === filterKey
      ? stored
      : { filterKey, pageIndex: 0, result: { status: 'loading', previous: null } };
  return {
    state,
    older: () => {
      controller.older();
    },
    newer: () => {
      controller.newer();
    },
    retry: () => {
      controller.retry();
    },
  };
}
