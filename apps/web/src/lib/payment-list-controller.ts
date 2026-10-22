import type { ApiClient } from './api';
import { type PaymentPage, type PaymentState, paymentListPath } from './payments';

/** What the merchant chose: everything that changes which payments match, plus page size. */
export interface ListFilters {
  status: PaymentState | null;
  q: string | null;
  limit: number;
}

export type ListResult =
  | { status: 'loading'; previous: PaymentPage | null }
  | { status: 'ready'; page: PaymentPage }
  | { status: 'error'; error: unknown };

export interface ListState {
  /** The filters this state belongs to (see filterKeyOf). */
  filterKey: string;
  /** 0 for the newest page. */
  pageIndex: number;
  result: ListResult;
}

export function filterKeyOf(filters: ListFilters): string {
  return JSON.stringify([filters.status, filters.q, filters.limit]);
}

/**
 * The payment list's paging and loading, free of React (bound with
 * useSyncExternalStore). Cursors are only valid for the filters that produced
 * them, so a filter change starts over at the newest page and forgets every
 * cursor and the page on screen; coming back to earlier filters starts fresh
 * too. Older and Newer keep the page on screen while the next one loads. Only
 * the latest request may change the state: earlier ones are aborted, and a
 * late answer to one is ignored.
 */
export class PaymentListController {
  private filters: ListFilters | null = null;
  private cursors: (string | null)[] = [null];
  private request: AbortController | undefined;
  private state: ListState = {
    filterKey: '',
    pageIndex: 0,
    result: { status: 'loading', previous: null },
  };
  private readonly listeners = new Set<() => void>();

  constructor(private readonly api: Pick<ApiClient, 'get'>) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getState = (): ListState => this.state;

  /** Shows the newest page for these filters; the same filters again change nothing. */
  setFilters(filters: ListFilters): void {
    const filterKey = filterKeyOf(filters);
    if (this.filters && filterKeyOf(this.filters) === filterKey) return;
    this.filters = filters;
    this.cursors = [null];
    this.load(null);
  }

  /** The next older page, keeping the current one on screen until it arrives. */
  older(): void {
    const { result } = this.state;
    if (result.status !== 'ready' || !result.page.nextCursor) return;
    this.cursors = [...this.cursors, result.page.nextCursor];
    this.load(result.page);
  }

  /** The next newer page, keeping the current one on screen until it arrives. */
  newer(): void {
    const { result } = this.state;
    if (this.cursors.length < 2 || result.status !== 'ready') return;
    this.cursors = this.cursors.slice(0, -1);
    this.load(result.page);
  }

  /** Asks again for the page that failed. */
  retry(): void {
    if (this.filters && this.state.result.status === 'error') this.load(null);
  }

  /** Stops the request in flight. A later setFilters loads again, even with the same filters. */
  dispose(): void {
    this.request?.abort();
    this.request = undefined;
    this.filters = null;
  }

  private load(previous: PaymentPage | null): void {
    const { filters } = this;
    if (!filters) return;
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    const filterKey = filterKeyOf(filters);
    const pageIndex = this.cursors.length - 1;
    this.set({ filterKey, pageIndex, result: { status: 'loading', previous } });

    const path = paymentListPath({ ...filters, cursor: this.cursors[pageIndex] ?? null });
    this.api.get<PaymentPage>(path, { signal: request.signal }).then(
      (page) => {
        if (this.request === request)
          this.set({ filterKey, pageIndex, result: { status: 'ready', page } });
      },
      (error: unknown) => {
        if (this.request === request)
          this.set({ filterKey, pageIndex, result: { status: 'error', error } });
      },
    );
  }

  private set(state: ListState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}
