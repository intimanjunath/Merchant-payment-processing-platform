import { beforeEach, describe, expect, it } from 'vitest';

import { ApiRequestError } from './api';
import { DETAILS_POLL_MS, PaymentDetailsController } from './payment-details-controller';
import type { Operation, PaymentDetails, PaymentState } from './payments';

const details = (
  state: PaymentState,
  pendingOperation: Operation | null = null,
): PaymentDetails => ({
  payment: {
    id: 'pay-1',
    state,
    amount: 1500,
    currency: 'USD',
    reference: 'order-1',
    paymentMethod: { brand: 'visa', last4: '4242' },
    failureReason: state === 'failed' ? 'card_declined' : null,
    settlementReview: false,
    createdAt: '2026-10-22T10:00:00.000Z',
    updatedAt: '2026-10-22T10:00:00.000Z',
  },
  pendingOperation,
  operations: [],
  transitions: [],
});

const paused: Operation = {
  id: 'op-1',
  action: 'capture',
  status: 'needs_review',
  reason: 'retries_exhausted',
  createdAt: '2026-10-22T10:00:00.000Z',
  completedAt: null,
};

/** Requests the test answers by hand; an abort is recorded, not settled. */
class ControlledApi {
  readonly calls: {
    path: string;
    aborted: () => boolean;
    answer: (body: PaymentDetails) => void;
    fail: (error: unknown) => void;
  }[] = [];

  readonly get = <T>(path: string, options: { signal?: AbortSignal } = {}): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      this.calls.push({
        path,
        aborted: () => options.signal?.aborted ?? false,
        answer: (body) => {
          resolve(body as T);
        },
        fail: reject,
      });
    });

  last() {
    const call = this.calls.at(-1);
    if (!call) throw new Error('no request made');
    return call;
  }
}

/** Timers the test fires by hand; a cleared timer is remembered. */
class ManualTimers {
  readonly scheduled: { callback: () => void; ms: number; cleared: boolean }[] = [];
  setTimeout = (callback: () => void, ms: number) => {
    this.scheduled.push({ callback, ms, cleared: false });
    return this.scheduled.length - 1;
  };
  clearTimeout = (handle: unknown) => {
    const timer = this.scheduled[handle as number];
    if (timer) timer.cleared = true;
  };
  /** Timers still waiting to fire. */
  live() {
    return this.scheduled.filter((timer) => !timer.cleared);
  }
  /** Fires the one live timer. */
  fire() {
    const live = this.live();
    if (live.length !== 1) throw new Error(`expected one live timer, found ${String(live.length)}`);
    const [timer] = live;
    if (timer) {
      timer.cleared = true;
      timer.callback();
    }
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const notFound = () =>
  new ApiRequestError(
    404,
    'NOT_FOUND',
    'The requested resource was not found.',
    'r',
    undefined,
    null,
  );

describe('PaymentDetailsController', () => {
  let api: ControlledApi;
  let timers: ManualTimers;
  let visible: boolean;
  let controller: PaymentDetailsController;

  beforeEach(() => {
    api = new ControlledApi();
    timers = new ManualTimers();
    visible = true;
    controller = new PaymentDetailsController('pay-1', {
      api,
      timers,
      isVisible: () => visible,
    });
  });

  async function answer(body: PaymentDetails) {
    api.last().answer(body);
    await flush();
  }

  it('checks a captured payment every five seconds until it settles', async () => {
    controller.refresh();
    expect(api.last().path).toBe('/payments/pay-1');
    await answer(details('captured'));
    expect(timers.live().map((timer) => timer.ms)).toEqual([DETAILS_POLL_MS]);

    timers.fire();
    expect(api.calls).toHaveLength(2);
    await answer(details('settled'));

    expect(controller.getState()).toMatchObject({ status: 'ready', details: details('settled') });
    expect(timers.live()).toHaveLength(0);
  });

  it('does not poll a payment only the merchant can move', async () => {
    controller.refresh();
    await answer(details('authorized'));
    expect(timers.live()).toHaveLength(0);
  });

  it('keeps polling while an operation is paused for review', async () => {
    controller.refresh();
    await answer(details('authorized', paused));
    expect(timers.live()).toHaveLength(1);
  });

  it('shows not found for a 404 and stops', async () => {
    controller.refresh();
    api.last().fail(notFound());
    await flush();
    expect(controller.getState()).toEqual({ status: 'not_found' });
    expect(timers.live()).toHaveLength(0);
  });

  it('keeps the details and keeps polling when a refresh fails', async () => {
    controller.refresh();
    await answer(details('captured'));
    timers.fire();
    api.last().fail(new Error('down'));
    await flush();

    expect(controller.getState()).toMatchObject({ status: 'ready', refreshFailed: true });
    expect(timers.live()).toHaveLength(1);
    timers.fire();
    await answer(details('settled'));
    expect(controller.getState()).toMatchObject({ status: 'ready', refreshFailed: false });
  });

  it('shows an error when the first load fails, and loads again on refresh', async () => {
    controller.refresh();
    const failure = new Error('down');
    api.last().fail(failure);
    await flush();
    expect(controller.getState()).toEqual({ status: 'error', error: failure });
    expect(timers.live()).toHaveLength(0);

    controller.refresh();
    await answer(details('authorized'));
    expect(controller.getState()).toMatchObject({ status: 'ready' });
  });

  it('skips polls while hidden and catches up when shown', async () => {
    controller.refresh();
    await answer(details('captured'));
    visible = false;
    timers.fire();
    expect(api.calls).toHaveLength(1);

    visible = true;
    controller.visible();
    expect(api.calls).toHaveLength(2);
  });

  it('does nothing on becoming visible when no poll was skipped', async () => {
    controller.refresh();
    await answer(details('captured'));
    controller.visible();
    expect(api.calls).toHaveLength(1);
  });

  it('stops on dispose: the request is aborted, its answer ignored, no more polls', async () => {
    controller.refresh();
    await answer(details('captured'));
    timers.fire();
    const inFlight = api.last();
    controller.dispose();

    expect(inFlight.aborted()).toBe(true);
    inFlight.answer(details('settled'));
    await flush();
    expect(controller.getState()).toMatchObject({ details: details('captured') });
    expect(timers.live()).toHaveLength(0);
  });

  it('cancels a pending poll on dispose', async () => {
    controller.refresh();
    await answer(details('captured'));
    controller.dispose();
    expect(timers.live()).toHaveLength(0);
  });

  it('cannot be revived by a stray refresh after dispose; only start() resumes it', async () => {
    controller.refresh();
    await answer(details('captured'));
    controller.dispose();

    controller.refresh();
    controller.visible();
    expect(api.calls).toHaveLength(1);
    expect(timers.live()).toHaveLength(0);

    controller.start();
    expect(api.calls).toHaveLength(2);
  });
});
