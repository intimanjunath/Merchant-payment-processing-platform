import { beforeEach, describe, expect, it } from 'vitest';

import { type ListFilters, PaymentListController } from './payment-list-controller';
import type { Payment, PaymentPage } from './payments';

const ALL: ListFilters = { status: null, q: null, limit: 25 };
const FAILED: ListFilters = { status: 'failed', q: null, limit: 25 };

const payment = (id: string, state: Payment['state'] = 'authorized'): Payment => ({
  id,
  state,
  amount: 1000,
  currency: 'USD',
  reference: `ref-${id}`,
  paymentMethod: { brand: 'visa', last4: '4242' },
  failureReason: state === 'failed' ? 'card_declined' : null,
  settlementReview: false,
  createdAt: '2026-10-22T10:00:00.000Z',
  updatedAt: '2026-10-22T10:00:00.000Z',
});
const page = (ids: string[], nextCursor: string | null = null): PaymentPage => ({
  items: ids.map((id) => payment(id)),
  nextCursor,
});

/**
 * Requests the test answers by hand. An abort is recorded but does not settle
 * the request, so a test can deliver a late answer the way a slow server would.
 */
class ControlledApi {
  readonly calls: {
    path: string;
    aborted: () => boolean;
    answer: (page: PaymentPage) => void;
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

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('PaymentListController', () => {
  let api: ControlledApi;
  let list: PaymentListController;

  beforeEach(() => {
    api = new ControlledApi();
    list = new PaymentListController(api);
  });

  /** Filters set, first page answered. */
  async function firstPage(filters: ListFilters, answer: PaymentPage) {
    list.setFilters(filters);
    api.last().answer(answer);
    await flush();
  }

  describe('cursor history', () => {
    it('starts All on page 1 again after All page 2 → Failed → All', async () => {
      await firstPage(ALL, page(['a1'], 'cursor-all-2'));
      list.older();
      expect(api.last().path).toBe('/payments?limit=25&cursor=cursor-all-2');
      api.last().answer(page(['a2'], 'cursor-all-3'));
      await flush();
      expect(list.getState().pageIndex).toBe(1);

      await firstPage(FAILED, page(['f1']));
      list.setFilters(ALL);

      expect(api.last().path).toBe('/payments?limit=25');
      expect(list.getState()).toMatchObject({
        pageIndex: 0,
        result: { status: 'loading', previous: null },
      });
      api.last().answer(page(['a1'], 'cursor-all-2'));
      await flush();
      expect(list.getState()).toMatchObject({ pageIndex: 0, result: { status: 'ready' } });
    });

    it('starts over when search or page size changes, not only status', async () => {
      await firstPage(ALL, page(['a1'], 'c2'));
      list.older();
      list.setFilters({ ...ALL, q: 'bike' });
      expect(api.last().path).toBe('/payments?q=bike&limit=25');

      await firstPage({ ...ALL, q: 'bike' }, page(['b1'], 'c2'));
      list.older();
      list.setFilters({ ...ALL, q: 'bike', limit: 10 });
      expect(api.last().path).toBe('/payments?q=bike&limit=10');
      expect(list.getState().pageIndex).toBe(0);
    });

    it('walks back with Newer through the cursors it walked forward with', async () => {
      await firstPage(ALL, page(['a1'], 'c2'));
      list.older();
      api.last().answer(page(['a2'], 'c3'));
      await flush();
      list.older();
      api.last().answer(page(['a3']));
      await flush();

      list.newer();
      expect(api.last().path).toBe('/payments?limit=25&cursor=c2');
      api.last().answer(page(['a2'], 'c3'));
      await flush();
      list.newer();
      expect(api.last().path).toBe('/payments?limit=25');
      expect(list.getState().pageIndex).toBe(0);
    });

    it('treats the same filters again as no change', async () => {
      await firstPage(ALL, page(['a1'], 'c2'));
      list.setFilters({ ...ALL });
      expect(api.calls).toHaveLength(1);
    });
  });

  describe('the page kept on screen while loading', () => {
    it('is kept for Older and Newer under the same filters', async () => {
      const first = page(['a1'], 'c2');
      await firstPage(ALL, first);
      list.older();
      expect(list.getState().result).toEqual({ status: 'loading', previous: first });

      const second = page(['a2']);
      api.last().answer(second);
      await flush();
      list.newer();
      expect(list.getState().result).toEqual({ status: 'loading', previous: second });
    });

    it('is dropped when the filters change, even part-way through paging', async () => {
      await firstPage(ALL, page(['a1'], 'c2'));
      list.setFilters(FAILED);
      expect(list.getState().result).toEqual({ status: 'loading', previous: null });

      await firstPage(ALL, page(['a1'], 'c2'));
      list.older();
      list.setFilters(FAILED);
      expect(list.getState().result).toEqual({ status: 'loading', previous: null });
    });

    it('is not shown after an error, and a retry loads without it', async () => {
      await firstPage(ALL, page(['a1'], 'c2'));
      list.older();
      const failure = new Error('down');
      api.last().fail(failure);
      await flush();
      expect(list.getState().result).toEqual({ status: 'error', error: failure });

      list.retry();
      expect(api.last().path).toBe('/payments?limit=25&cursor=c2');
      expect(list.getState().result).toEqual({ status: 'loading', previous: null });
    });
  });

  describe('late answers', () => {
    it('aborts the older request and ignores its answer', async () => {
      list.setFilters(ALL);
      const slow = api.last();
      list.setFilters(FAILED);

      expect(slow.aborted()).toBe(true);
      slow.answer(page(['a1']));
      await flush();
      expect(list.getState()).toMatchObject({ result: { status: 'loading', previous: null } });

      api.last().answer(page(['f1']));
      await flush();
      const state = list.getState();
      expect(state.result.status === 'ready' && state.result.page.items[0]?.id).toBe('f1');
    });

    it('loads again after dispose, even with the same filters (a remounted page)', () => {
      list.setFilters(ALL);
      list.dispose();
      expect(api.last().aborted()).toBe(true);

      list.setFilters(ALL);
      expect(api.calls).toHaveLength(2);
    });
  });
});
