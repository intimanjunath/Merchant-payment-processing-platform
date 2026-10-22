import { beforeEach, describe, expect, it } from 'vitest';

import { ApiRequestError, type ErrorCode, type RequestOptions } from './api';
import { clearMerchantRecords, recordKey } from './browser-records';
import {
  classifyError,
  finishCreate,
  type MutationBody,
  type PendingAction,
  PendingActions,
  parsePendingAction,
  runPending,
  sendPending,
  submitCreate,
} from './pending-actions';
import type { Operation } from './payments';

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

const create = (key = 'key-create'): Extract<PendingAction, { kind: 'create' }> => ({
  kind: 'create',
  key,
  input: { amount: 1500, reference: 'order-1', paymentMethod: 'pm_lost_response' },
  paymentId: null,
  startedAt: '2026-10-22T10:00:00.000Z',
});
const capture = (paymentId = 'pay-1', key = 'key-capture'): PendingAction => ({
  kind: 'capture',
  key,
  paymentId,
  startedAt: '2026-10-22T10:00:00.000Z',
});

const apiError = (status: number, code: ErrorCode) =>
  new ApiRequestError(status, code, 'message', 'req-1', undefined, null);

const body = (status: Operation['status']): MutationBody =>
  ({
    payment: { id: 'pay-1', state: 'pending' },
    operation: { id: 'op-1', action: 'authorize', status },
  }) as MutationBody;

describe('PendingActions', () => {
  let storage: Storage;
  let acme: PendingActions;

  beforeEach(() => {
    storage = memoryStorage();
    acme = new PendingActions(storage, 'acme');
  });

  it('keeps a create and an action per payment, under the merchant’s prefix', () => {
    acme.save(create());
    acme.save(capture('pay-1'));

    expect(acme.create()).toEqual(create());
    expect(acme.forPayment('pay-1')).toEqual(capture('pay-1'));
    expect(acme.forPayment('pay-2')).toBeNull();
    expect(storage.getItem(recordKey('acme', 'pending:create'))).not.toBeNull();
    expect(storage.getItem(recordKey('acme', 'pending:payment:pay-1'))).not.toBeNull();
  });

  it('never shows one merchant’s pending work to another', () => {
    acme.save(create());
    const bicycle = new PendingActions(storage, 'bicycle');
    expect(bicycle.create()).toBeNull();
  });

  it('finds the create that made a payment once its ID is known', () => {
    acme.save({ ...create(), paymentId: 'pay-9' });
    expect(acme.forPayment('pay-9')).toMatchObject({ kind: 'create', key: 'key-create' });
  });

  it('clears only the exact action it was given', () => {
    acme.save(capture('pay-1', 'key-new'));
    acme.clear(capture('pay-1', 'key-old'));
    expect(acme.forPayment('pay-1')).toMatchObject({ key: 'key-new' });

    acme.clear(capture('pay-1', 'key-new'));
    expect(acme.forPayment('pay-1')).toBeNull();
  });

  it('ignores corrupt or foreign records', () => {
    storage.setItem(recordKey('acme', 'pending:create'), '{not json');
    storage.setItem(
      recordKey('acme', 'pending:payment:pay-1'),
      JSON.stringify({ kind: 'capture' }),
    );
    expect(acme.create()).toBeNull();
    expect(acme.forPayment('pay-1')).toBeNull();
  });

  it('degrades to nothing pending when storage refuses', () => {
    const refuse = () => {
      throw new Error('storage refused');
    };
    const broken: Storage = {
      length: 0,
      key: () => null,
      getItem: refuse,
      setItem: refuse,
      removeItem: refuse,
      clear: refuse,
    };
    const store = new PendingActions(broken, 'acme');
    expect(store.save(create())).toBe(false);
    expect(store.create()).toBeNull();
  });
});

describe('parsePendingAction', () => {
  it('accepts the stored shapes and rejects the rest', () => {
    expect(parsePendingAction(create())).toEqual(create());
    expect(parsePendingAction(capture())).toEqual(capture());
    expect(parsePendingAction({ ...capture(), key: '' })).toBeNull();
    expect(parsePendingAction({ ...create(), input: { amount: '15' } })).toBeNull();
    expect(
      parsePendingAction({ ...create(), input: { ...create().input, paymentMethod: 'pm_other' } }),
    ).toBeNull();
    expect(parsePendingAction({ kind: 'delete', key: 'k', startedAt: 'x' })).toBeNull();
    expect(parsePendingAction(null)).toBeNull();
  });
});

describe('classifyError', () => {
  it('settles the action on refusals that reserve nothing, and on the provider’s refusal', () => {
    for (const [status, code] of [
      [400, 'VALIDATION_ERROR'],
      [404, 'NOT_FOUND'],
      [409, 'IDEMPOTENCY_CONFLICT'],
      [409, 'OPERATION_IN_PROGRESS'],
      [409, 'INVALID_STATE_TRANSITION'],
      [422, 'PROVIDER_REJECTED'],
    ] as const) {
      expect(classifyError(apiError(status, code)).kind).toBe('refused');
    }
  });

  it('keeps the action pending when the answer says nothing about it', () => {
    for (const error of [
      apiError(0, 'NETWORK_ERROR'),
      apiError(401, 'UNAUTHENTICATED'),
      apiError(403, 'CSRF_REJECTED'),
      apiError(503, 'SERVICE_UNAVAILABLE'),
      apiError(500, 'INTERNAL_ERROR'),
      new Error('anything else'),
    ]) {
      expect(classifyError(error).kind).toBe('uncertain');
    }
  });
});

describe('sendPending', () => {
  const calls: { path: string; options: RequestOptions }[] = [];
  let answer: () => Promise<MutationBody>;
  const api = {
    post: <T>(path: string, options: RequestOptions = {}): Promise<T> => {
      calls.push({ path, options });
      return answer() as Promise<T>;
    },
  };

  beforeEach(() => {
    calls.length = 0;
  });

  it('sends a create with its input and its own key, every time', async () => {
    answer = () => Promise.resolve(body('awaiting_confirmation'));
    await sendPending(api, create());
    await sendPending(api, create());
    expect(calls).toEqual([
      { path: '/payments', options: { body: create().input, idempotencyKey: 'key-create' } },
      { path: '/payments', options: { body: create().input, idempotencyKey: 'key-create' } },
    ]);
  });

  it('sends a capture with no body to its payment', async () => {
    answer = () => Promise.resolve(body('succeeded'));
    await sendPending(api, capture('pay 1'));
    expect(calls).toEqual([
      { path: '/payments/pay%201/capture', options: { idempotencyKey: 'key-capture' } },
    ]);
  });

  it('tells finished, still-open, refused and uncertain answers apart', async () => {
    answer = () => Promise.resolve(body('succeeded'));
    expect((await sendPending(api, capture())).kind).toBe('done');
    answer = () => Promise.resolve(body('rejected'));
    expect((await sendPending(api, create())).kind).toBe('done');
    answer = () => Promise.resolve(body('awaiting_confirmation'));
    expect((await sendPending(api, create())).kind).toBe('unresolved');
    answer = () => Promise.reject(apiError(422, 'PROVIDER_REJECTED'));
    expect((await sendPending(api, capture())).kind).toBe('refused');
    answer = () => Promise.reject(apiError(0, 'NETWORK_ERROR'));
    expect((await sendPending(api, capture())).kind).toBe('uncertain');
  });
});

describe('runPending', () => {
  it('remembers the payment a 202 create reserved, and clears it once done', async () => {
    const storage = memoryStorage();
    const store = new PendingActions(storage, 'acme');
    const action = create();
    store.save(action);
    let reply: MutationBody = {
      ...body('awaiting_confirmation'),
      payment: { id: 'pay-7' },
    } as MutationBody;
    const api = { post: <T>() => Promise.resolve(reply as T) };

    expect((await runPending(api, store, action)).kind).toBe('unresolved');
    expect(store.create()).toMatchObject({ key: 'key-create', paymentId: 'pay-7' });

    reply = body('succeeded');
    await runPending(api, store, store.create() ?? action);
    expect(store.create()).toBeNull();
  });

  it('keeps an uncertain create exactly as it was', async () => {
    const store = new PendingActions(memoryStorage(), 'acme');
    store.save(create());
    const api = { post: <T>(): Promise<T> => Promise.reject(apiError(0, 'NETWORK_ERROR')) };
    expect((await runPending(api, store, create())).kind).toBe('uncertain');
    expect(store.create()).toEqual(create());
  });
});

describe('late answers and storage failures', () => {
  /** One create request the test answers by hand. */
  function heldApi() {
    const held: { resolve: (body: MutationBody) => void; calls: number } = {
      resolve: () => undefined,
      calls: 0,
    };
    const api = {
      post: <T>(): Promise<T> =>
        new Promise<T>((resolve) => {
          held.calls += 1;
          held.resolve = (body) => {
            resolve(body as T);
          };
        }),
    };
    return { api, held };
  }
  const accepted = { ...body('awaiting_confirmation'), payment: { id: 'pay-7' } } as MutationBody;

  it('does not bring back a create record that sign-out cleared while it was in flight', async () => {
    const storage = memoryStorage();
    const store = new PendingActions(storage, 'acme');
    const { api, held } = heldApi();
    store.save(create());
    const sending = runPending(api, store, create());

    clearMerchantRecords(storage, 'acme');
    held.resolve(accepted);
    await sending;
    expect(store.create()).toBeNull();
  });

  it('does not overwrite a newer create with an older one’s late answer', async () => {
    const store = new PendingActions(memoryStorage(), 'acme');
    const { api, held } = heldApi();
    store.save(create('key-old'));
    const sending = runPending(api, store, create('key-old'));

    store.clear(create('key-old'));
    store.save(create('key-new'));
    held.resolve(accepted);
    await sending;
    expect(store.create()).toEqual(create('key-new'));
  });

  it('sends nothing when the record can’t be saved', async () => {
    const refuse = () => {
      throw new Error('storage refused');
    };
    const store = new PendingActions(
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
    const { api, held } = heldApi();
    const result = await submitCreate(api, store, create().input, {
      key: 'key-1',
      now: new Date('2026-10-22T10:00:00.000Z'),
      isActive: () => true,
    });
    expect(result).toEqual({ kind: 'not_saved' });
    expect(held.calls).toBe(0);
  });

  it('reports nothing to a page that was left, but still records the answer', async () => {
    const store = new PendingActions(memoryStorage(), 'acme');
    const { api, held } = heldApi();
    let active = true;
    const submitting = submitCreate(api, store, create().input, {
      key: 'key-1',
      now: new Date('2026-10-22T10:00:00.000Z'),
      isActive: () => active,
    });
    expect(store.create()).toMatchObject({ key: 'key-1', paymentId: null });

    active = false;
    held.resolve(accepted);
    expect(await submitting).toEqual({ kind: 'left' });
    expect(store.create()).toMatchObject({ key: 'key-1', paymentId: 'pay-7' });
  });

  it('sends a create again only with its original key', async () => {
    const store = new PendingActions(memoryStorage(), 'acme');
    store.save(create('key-original'));
    const keys: (string | undefined)[] = [];
    const api = {
      post: <T>(_path: string, options: RequestOptions = {}): Promise<T> => {
        keys.push(options.idempotencyKey);
        return Promise.reject(apiError(0, 'NETWORK_ERROR'));
      },
    };
    const pending = store.create();
    if (!pending) throw new Error('expected a pending create');
    await finishCreate(api, store, pending, () => true);
    await finishCreate(api, store, store.create() ?? pending, () => true);
    expect(keys).toEqual(['key-original', 'key-original']);
    expect(store.create()).toMatchObject({ key: 'key-original' });
  });
});
