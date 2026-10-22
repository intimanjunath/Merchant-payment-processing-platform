import { type ApiClient, ApiRequestError } from './api';
import { isUnresolved, type PaymentDetails } from './payments';
import type { Timers } from './session-controller';

/** How often an unresolved payment is checked again (design §8). */
export const DETAILS_POLL_MS = 5_000;

export type DetailsState =
  | { status: 'loading' }
  | {
      status: 'ready';
      details: PaymentDetails;
      /** The last refresh failed; the details shown are from before it. */
      refreshFailed: boolean;
    }
  | { status: 'not_found' }
  | { status: 'error'; error: unknown };

export interface DetailsOptions {
  api: Pick<ApiClient, 'get'>;
  timers: Timers;
  /** Whether the page is visible; hidden pages don't poll. */
  isVisible: () => boolean;
  intervalMs?: number;
}

/**
 * One payment's details, kept current while something may still change on
 * its own (see isUnresolved): checked again every five seconds until the
 * payment settles into a state only the merchant can move. A failed refresh
 * keeps the details on screen and keeps checking; a first load that fails
 * waits for refresh(). Polling pauses while the page is hidden and catches up
 * when it is shown again. Only the latest request may update the state.
 */
export class PaymentDetailsController {
  private state: DetailsState = { status: 'loading' };
  private request: AbortController | undefined;
  private timer: unknown;
  /** A poll came due while the page was hidden. */
  private dueWhileHidden = false;
  private disposed = false;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly paymentId: string,
    private readonly options: DetailsOptions,
  ) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getState = (): DetailsState => this.state;

  /** Loads now; also the retry after a failure. */
  refresh(): void {
    this.disposed = false;
    this.clearTimer();
    this.dueWhileHidden = false;
    this.load();
  }

  /** The page became visible again: catch up if a poll was skipped. */
  visible(): void {
    if (this.dueWhileHidden && !this.disposed) this.refresh();
  }

  /** Stops polling and abandons the request in flight. refresh() starts again. */
  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.request?.abort();
    this.request = undefined;
  }

  private load(): void {
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    const path = `/payments/${encodeURIComponent(this.paymentId)}`;
    this.options.api.get<PaymentDetails>(path, { signal: request.signal }).then(
      (details) => {
        if (this.request !== request) return;
        this.set({ status: 'ready', details, refreshFailed: false });
        if (isUnresolved(details)) this.schedule();
      },
      (error: unknown) => {
        if (this.request !== request) return;
        if (error instanceof ApiRequestError && error.code === 'NOT_FOUND') {
          this.set({ status: 'not_found' });
        } else if (this.state.status === 'ready') {
          this.set({ ...this.state, refreshFailed: true });
          this.schedule();
        } else {
          this.set({ status: 'error', error });
        }
      },
    );
  }

  private schedule(): void {
    this.clearTimer();
    this.timer = this.options.timers.setTimeout(() => {
      this.timer = undefined;
      if (this.options.isVisible()) this.load();
      else this.dueWhileHidden = true;
    }, this.options.intervalMs ?? DETAILS_POLL_MS);
  }

  private clearTimer(): void {
    if (this.timer !== undefined) this.options.timers.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private set(state: DetailsState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}
