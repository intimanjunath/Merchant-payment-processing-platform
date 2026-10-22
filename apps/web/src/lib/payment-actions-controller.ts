import type { ApiClient, ApiRequestError } from './api';
import {
  NOT_SAVED_TEXT,
  type PendingAction,
  type PendingActions,
  runPending,
} from './pending-actions';
import type { PaymentDetails, PaymentState } from './payments';

export interface ActionMessage {
  severity: 'success' | 'warning' | 'error';
  text: string;
  /** A success note belongs to the state it reports; it goes once the payment moves on. */
  forState?: PaymentState;
}

export interface ActionsState {
  /** The action whose outcome isn't known yet, if any; it blocks new ones. */
  pending: PendingAction | null;
  busy: boolean;
  message: ActionMessage | null;
  /** After an uncertain answer: the action retry() sends again, with its own key. */
  retryable: PendingAction | null;
}

const DONE: Record<'capture' | 'refund', string> = {
  capture: 'Capture confirmed. The money is on its way to your account.',
  refund: 'Refund confirmed. The money is on its way back to the customer.',
};

/** Why an action was refused, in terms of what to do next. */
export function refusalText(kind: PendingAction['kind'], error: ApiRequestError): string {
  const noun = kind === 'create' ? 'payment' : kind;
  switch (error.code) {
    case 'PROVIDER_REJECTED':
      return `The bank refused the ${noun}. The payment hasn’t changed.`;
    case 'OPERATION_IN_PROGRESS':
      return 'Another action on this payment is still being confirmed. Wait for it to finish.';
    case 'INVALID_STATE_TRANSITION':
      return `This payment can’t be ${kind === 'refund' ? 'refunded' : 'captured'} in its current state. The page now shows where it stands.`;
    default:
      return error.message;
  }
}

/**
 * Capture and refund for one payment, framework-free. Each action is saved
 * with a new idempotency key before it is sent and kept until its outcome is
 * definite (runPending). An action left pending (a reload, a lost response)
 * is sent once more with its own key when the details show no unresolved
 * operation: that collects the stored outcome rather than acting twice.
 */
export class PaymentActionsController {
  private state: ActionsState;
  /**
   * The pending action already sent since its last 202, so a details refresh
   * doesn't send it again. A 202 clears it: the action is sent once more when
   * its operation resolves. An uncertain answer keeps it: retry() is the merchant's.
   */
  private resumedKey: string | null = null;
  private active = true;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly paymentId: string,
    private readonly options: {
      api: Pick<ApiClient, 'post'>;
      store: PendingActions;
      newKey: () => string;
      now: () => Date;
      /** Called after every answer, so the details reload. */
      onSettled: () => void;
    },
  ) {
    this.state = {
      pending: options.store.forPayment(paymentId),
      busy: false,
      message: null,
      retryable: null,
    };
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getState = (): ActionsState => this.state;

  /** A new capture or refund, under a new key. Ignored while another is pending. */
  start(kind: 'capture' | 'refund'): void {
    if (this.state.busy || this.state.pending) return;
    const action: PendingAction = {
      kind,
      key: this.options.newKey(),
      paymentId: this.paymentId,
      startedAt: this.options.now().toISOString(),
    };
    // No record, no request: a lost answer could otherwise only be retried with a new key.
    if (!this.options.store.save(action)) {
      this.set({ ...this.state, message: { severity: 'error', text: NOT_SAVED_TEXT } });
      return;
    }
    this.resumedKey = action.key;
    void this.run(action);
  }

  /** Sends the uncertain action again, with the same key. */
  retry(): void {
    if (this.state.retryable && !this.state.busy) void this.run(this.state.retryable);
  }

  /** Called with every details answer: resumes a pending action once nothing is in flight. */
  detailsChanged(details: PaymentDetails): void {
    const { forState } = this.state.message ?? {};
    if (forState && forState !== details.payment.state) this.set({ ...this.state, message: null });
    const { pending, busy } = this.state;
    if (!pending || busy || details.pendingOperation !== null) return;
    if (this.resumedKey === pending.key) return;
    this.resumedKey = pending.key;
    void this.run(pending);
  }

  private async run(action: PendingAction): Promise<void> {
    this.set({ ...this.state, busy: true, message: null, retryable: null });
    const attempt = await runPending(this.options.api, this.options.store, action);
    // The page was left: the store is up to date, and nothing else may run for it.
    if (!this.active) return;
    if (attempt.kind === 'unresolved') this.resumedKey = null;
    let message: ActionMessage | null = null;
    let retryable: PendingAction | null = null;
    if (attempt.kind === 'done' && action.kind !== 'create') {
      message = {
        severity: 'success',
        text: DONE[action.kind],
        forState: attempt.body.payment.state,
      };
    } else if (attempt.kind === 'refused') {
      message = { severity: 'error', text: refusalText(action.kind, attempt.error) };
    } else if (attempt.kind === 'uncertain') {
      const what = action.kind === 'create' ? 'payment' : action.kind;
      message = {
        severity: 'warning',
        text: `We couldn’t confirm the ${what} went through. Trying again sends the same request, so it can’t happen twice.`,
      };
      retryable = action;
    }
    this.set({
      pending: this.options.store.forPayment(this.paymentId),
      busy: false,
      message,
      retryable,
    });
    this.options.onSettled();
  }

  /** The page is showing this payment (again). */
  activate(): void {
    this.active = true;
  }

  /** The page is gone: later answers update the store only, never the page or the details. */
  dispose(): void {
    this.active = false;
  }

  private set(state: ActionsState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}
