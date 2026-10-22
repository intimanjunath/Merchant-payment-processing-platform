import { beforeEach, describe, expect, it } from 'vitest';

import { ApiRequestError, type RequestOptions } from './api';
import { PaymentActionsController } from './payment-actions-controller';
import {
  type MutationBody,
  NOT_SAVED_TEXT,
  type PendingAction,
  PendingActions,
} from './pending-actions';
import type { Operation, PaymentDetails } from './payments';

function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    key: (index: number) => [...items.keys()][index] ?? null,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
    removeItem: (key: string) => {
      items.delete(key);
    },
    clear: () => {
      items.clear();
    },
  };
}

const operation = (status: Operation['status']): Operation => ({
  id: 'op-1',
  action: 'capture',
  status,
  reason: null,
  createdAt: '2026-10-22T10:00:00.000Z',
  completedAt: null,
});
const body = (
  status: Operation['status'],
  state: PaymentDetails['payment']['state'] = 'captured',
) => ({ payment: { id: 'pay-1', state }, operation: operation(status) }) as MutationBody;
const detailsWith = (
  pendingOperation: Operation | null,
  state: PaymentDetails['payment']['state'] = 'authorized',
) => ({ payment: { id: 'pay-1', state }, pendingOperation }) as PaymentDetails;

/** Mutations the test answers by hand, recording what each request carried. */
class ControlledApi {
  readonly calls: {
    path: string;
    key: string | undefined;
    pendingWhenSent: PendingAction | null;
    resolve: (value: MutationBody) => void;
    reject: (error: unknown) => void;
  }[] = [];

  constructor(private readonly store: () => PendingActions) {}

  readonly post = <T>(path: string, options: RequestOptions = {}): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      this.calls.push({
        path,
        key: options.idempotencyKey,
        pendingWhenSent: this.store().forPayment('pay-1'),
        resolve: (value) => {
          resolve(value as T);
        },
        reject,
      });
    });

  last() {
    const call = this.calls.at(-1);
    if (!call) throw new Error('no request made');
    return call;
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('PaymentActionsController', () => {
  let storage: Storage;
  let store: PendingActions;
  let api: ControlledApi;
  let settled: number;
  let keys: number;

  const controller = () =>
    new PaymentActionsController('pay-1', {
      api,
      store,
      newKey: () => `key-${String((keys += 1))}`,
      now: () => new Date('2026-10-22T10:00:00.000Z'),
      onSettled: () => {
        settled += 1;
      },
    });

  beforeEach(() => {
    storage = memoryStorage();
    store = new PendingActions(storage, 'acme');
    api = new ControlledApi(() => store);
    settled = 0;
    keys = 0;
  });

  it('saves the action before sending it, and clears it on a definite answer', async () => {
    const actions = controller();
    actions.start('capture');

    expect(api.last()).toMatchObject({
      path: '/payments/pay-1/capture',
      key: 'key-1',
      pendingWhenSent: { kind: 'capture', key: 'key-1' },
    });
    expect(actions.getState()).toMatchObject({ busy: true, pending: null });

    api.last().resolve(body('succeeded'));
    await flush();
    expect(store.forPayment('pay-1')).toBeNull();
    expect(actions.getState()).toMatchObject({
      busy: false,
      pending: null,
      message: { severity: 'success' },
    });
    expect(settled).toBe(1);
  });

  it('keeps a 202 pending, waits while the operation is open, then collects the outcome with the same key', async () => {
    const actions = controller();
    actions.start('capture');
    api.last().resolve(body('awaiting_confirmation'));
    await flush();
    expect(actions.getState().pending).toMatchObject({ key: 'key-1' });

    actions.detailsChanged(detailsWith(operation('awaiting_confirmation')));
    expect(api.calls).toHaveLength(1);

    actions.detailsChanged(detailsWith(null));
    expect(api.calls).toHaveLength(2);
    expect(api.last().key).toBe('key-1');
    api.last().resolve(body('succeeded'));
    await flush();
    expect(actions.getState().pending).toBeNull();

    actions.detailsChanged(detailsWith(null));
    expect(api.calls).toHaveLength(2);
  });

  it('resumes an action left by an earlier page, once, with its own key', async () => {
    store.save({
      kind: 'refund',
      key: 'key-from-before-reload',
      paymentId: 'pay-1',
      startedAt: '2026-10-22T09:59:00.000Z',
    });
    const actions = controller();
    expect(actions.getState().pending).toMatchObject({ key: 'key-from-before-reload' });

    actions.detailsChanged(detailsWith(null));
    expect(api.calls.map((call) => [call.path, call.key])).toEqual([
      ['/payments/pay-1/refund', 'key-from-before-reload'],
    ]);

    // No answer to the resend: later refreshes don't send it again; retry() is the merchant's.
    api.last().reject(new ApiRequestError(0, 'NETWORK_ERROR', 'down', null, undefined, null));
    await flush();
    actions.detailsChanged(detailsWith(null));
    actions.detailsChanged(detailsWith(null));
    expect(api.calls).toHaveLength(1);

    actions.retry();
    expect(api.last().key).toBe('key-from-before-reload');
    api.last().resolve(body('succeeded', 'refunded'));
    await flush();
    expect(store.forPayment('pay-1')).toBeNull();
  });

  it('clears a refused action and says why', async () => {
    const actions = controller();
    actions.start('capture');
    api
      .last()
      .reject(new ApiRequestError(422, 'PROVIDER_REJECTED', 'Rejected', 'r', undefined, null));
    await flush();
    expect(store.forPayment('pay-1')).toBeNull();
    expect(actions.getState().message).toEqual({
      severity: 'error',
      text: 'The bank refused the capture. The payment hasn’t changed.',
    });
  });

  it('keeps an uncertain action and retries it with the same key', async () => {
    const actions = controller();
    actions.start('refund');
    api.last().reject(new ApiRequestError(0, 'NETWORK_ERROR', 'down', null, undefined, null));
    await flush();
    expect(actions.getState()).toMatchObject({
      pending: { key: 'key-1' },
      retryable: { key: 'key-1' },
      message: { severity: 'warning' },
    });

    actions.retry();
    expect(api.last().key).toBe('key-1');
    expect(keys).toBe(1);
  });

  it('starts nothing new while an action is pending or in flight', async () => {
    const actions = controller();
    actions.start('capture');
    actions.start('capture');
    expect(api.calls).toHaveLength(1);

    api.last().resolve(body('awaiting_confirmation'));
    await flush();
    actions.start('capture');
    expect(api.calls).toHaveLength(1);
  });

  it('drops a success note once the payment moves past the state it reported', async () => {
    const actions = controller();
    actions.start('capture');
    api.last().resolve(body('succeeded', 'captured'));
    await flush();

    actions.detailsChanged(detailsWith(null, 'captured'));
    expect(actions.getState().message).toMatchObject({ severity: 'success' });
    actions.detailsChanged(detailsWith(null, 'settled'));
    expect(actions.getState().message).toBeNull();
  });

  it('keeps a warning or an error until the next action', async () => {
    const actions = controller();
    actions.start('refund');
    api.last().reject(new ApiRequestError(0, 'NETWORK_ERROR', 'down', null, undefined, null));
    await flush();
    actions.detailsChanged(detailsWith(null, 'refunded'));
    expect(actions.getState().message).toMatchObject({ severity: 'warning' });
  });

  it('sends nothing, and says so, when the record can’t be saved', () => {
    const refuse = () => {
      throw new Error('storage refused');
    };
    store = new PendingActions(
      {
        length: 0,
        key: () => null,
        getItem: () => null,
        setItem: refuse,
        removeItem: refuse,
        clear: refuse,
      },
      'acme',
    );
    const actions = controller();
    actions.start('capture');

    expect(api.calls).toHaveLength(0);
    expect(actions.getState()).toMatchObject({
      busy: false,
      pending: null,
      message: { severity: 'error', text: NOT_SAVED_TEXT },
    });
  });

  it('lets a late answer update the store, but not the page it left', async () => {
    const actions = controller();
    let notified = 0;
    actions.subscribe(() => {
      notified += 1;
    });
    actions.start('capture');
    const busyNotifications = notified;
    actions.dispose();

    api.last().resolve(body('succeeded'));
    await flush();
    expect(store.forPayment('pay-1')).toBeNull();
    expect(settled).toBe(0);
    expect(notified).toBe(busyNotifications);
  });
});
