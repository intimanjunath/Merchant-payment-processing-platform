import { type ApiClient, ApiRequestError, type ErrorCode } from './api';
import { recordKey } from './browser-records';
import type { Operation, Payment } from './payments';

/** The test payment-method tokens the provider accepts (spec §6). */
export const TEST_TOKENS = [
  'pm_card_visa',
  'pm_card_declined',
  'pm_timeout',
  'pm_lost_response',
] as const;
export type TestToken = (typeof TEST_TOKENS)[number];

export function isTestToken(value: unknown): value is TestToken {
  return typeof value === 'string' && (TEST_TOKENS as readonly string[]).includes(value);
}

export interface CreateInput {
  amount: number;
  reference: string;
  paymentMethod: TestToken;
}

/**
 * An action sent (or about to be sent) whose outcome isn't known yet. It is
 * saved before the first request and kept until a definite answer, so a
 * reload or a lost response can only lead to the same request again, with
 * the same idempotency key, never to a second charge.
 */
export type PendingAction =
  | {
      kind: 'create';
      key: string;
      input: CreateInput;
      /** Known once the API has answered with the payment it reserved. */
      paymentId: string | null;
      startedAt: string;
    }
  | { kind: 'capture' | 'refund'; key: string; paymentId: string; startedAt: string };

/** 200, 201 and 202 bodies (spec §4.4). */
export interface MutationBody {
  payment: Payment;
  operation: Operation;
}

export type Attempt =
  /** 200 or 201: the action is finished, whatever its outcome. */
  | { kind: 'done'; body: MutationBody }
  /** 202: accepted, outcome still unknown; the platform keeps working on it. */
  | { kind: 'unresolved'; body: MutationBody }
  /** A definite refusal; nothing more will come from this key. */
  | { kind: 'refused'; error: ApiRequestError }
  /** No usable answer: it may or may not have been received. Send again with the same key. */
  | { kind: 'uncertain'; error: unknown };

/**
 * Errors that settle the action for good. 400, 404 and 409 mean nothing was
 * reserved under the key (spec §2.7: those responses aren't stored); 422 is
 * the provider's stored refusal. Everything else (401 after an expired
 * session, 403, 5xx, no answer at all) might hide a reserved operation, so
 * the action stays pending and is sent again with the same key.
 */
const REFUSALS: ReadonlySet<ErrorCode> = new Set([
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'IDEMPOTENCY_CONFLICT',
  'OPERATION_IN_PROGRESS',
  'INVALID_STATE_TRANSITION',
  'PROVIDER_REJECTED',
]);

export function classifyError(error: unknown): Attempt {
  if (error instanceof ApiRequestError && REFUSALS.has(error.code)) {
    return { kind: 'refused', error };
  }
  return { kind: 'uncertain', error };
}

/** Sends the action with its own key. Safe to call again for the same record. */
export async function sendPending(
  api: Pick<ApiClient, 'post'>,
  action: PendingAction,
): Promise<Attempt> {
  try {
    const body =
      action.kind === 'create'
        ? await api.post<MutationBody>('/payments', {
            body: action.input,
            idempotencyKey: action.key,
          })
        : await api.post<MutationBody>(
            `/payments/${encodeURIComponent(action.paymentId)}/${action.kind}`,
            { idempotencyKey: action.key },
          );
    // The client resolves 200, 201 and 202 alike; 202 leaves the operation unresolved.
    const unresolved = ['reserved', 'awaiting_confirmation', 'needs_review'].includes(
      body.operation.status,
    );
    return unresolved ? { kind: 'unresolved', body } : { kind: 'done', body };
  } catch (error) {
    return classifyError(error);
  }
}

const CREATE_SLOT = 'pending:create';
const paymentSlot = (paymentId: string) => `pending:payment:${paymentId}`;

/**
 * Pending actions in sessionStorage, scoped to the merchant (browser-records),
 * so they survive a reload but not the tab, never show up for another
 * merchant, and go on sign-out. At most one create and one action per
 * payment are pending, matching the API's one unresolved mutation per payment.
 * Storage that can't be read or written (private mode, quota) degrades to
 * "nothing pending" rather than breaking the page.
 */
export class PendingActions {
  constructor(
    private readonly storage: Storage,
    private readonly merchantId: string,
  ) {}

  /** A create whose outcome isn't known yet. */
  create(): Extract<PendingAction, { kind: 'create' }> | null {
    const action = this.read(CREATE_SLOT);
    return action?.kind === 'create' ? action : null;
  }

  /** What is pending for this payment: a capture or refund, or the create that made it. */
  forPayment(paymentId: string): PendingAction | null {
    const action = this.read(paymentSlot(paymentId));
    if (action && action.kind !== 'create' && action.paymentId === paymentId) return action;
    const create = this.create();
    return create?.paymentId === paymentId ? create : null;
  }

  /** Saves before sending; false if storage refused (the action then can't survive a reload). */
  save(action: PendingAction): boolean {
    try {
      this.storage.setItem(this.key(this.slot(action)), JSON.stringify(action));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Updates a pending action in place, only if the same action (same key) is
   * still stored: a late answer must not bring back a record that sign-out
   * cleared, or overwrite a newer one.
   */
  replace(action: PendingAction): boolean {
    if (this.read(this.slot(action))?.key !== action.key) return false;
    return this.save(action);
  }

  /** Forgets the action once its outcome is definite. Only removes this exact action. */
  clear(action: PendingAction): void {
    const stored = this.read(this.slot(action));
    if (stored?.key !== action.key) return;
    try {
      this.storage.removeItem(this.key(this.slot(action)));
    } catch {
      // Nothing to do: the next read will find it and send it again, harmlessly.
    }
  }

  private slot(action: PendingAction): string {
    return action.kind === 'create' ? CREATE_SLOT : paymentSlot(action.paymentId);
  }

  private key(slot: string): string {
    return recordKey(this.merchantId, slot);
  }

  private read(slot: string): PendingAction | null {
    let raw: string | null;
    try {
      raw = this.storage.getItem(this.key(slot));
    } catch {
      return null;
    }
    if (raw === null) return null;
    try {
      return parsePendingAction(JSON.parse(raw));
    } catch {
      return null;
    }
  }
}

/** A stored record, checked field by field; anything else is ignored. */
export function parsePendingAction(value: unknown): PendingAction | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const { kind, key, startedAt } = record;
  if (typeof key !== 'string' || key === '' || typeof startedAt !== 'string') return null;
  if (kind === 'create') {
    const input = record.input as Partial<CreateInput> | undefined;
    const paymentId = record.paymentId;
    if (
      typeof input?.amount !== 'number' ||
      typeof input.reference !== 'string' ||
      !isTestToken(input.paymentMethod) ||
      !(paymentId === null || typeof paymentId === 'string')
    ) {
      return null;
    }
    return {
      kind,
      key,
      startedAt,
      paymentId,
      input: {
        amount: input.amount,
        reference: input.reference,
        paymentMethod: input.paymentMethod,
      },
    };
  }
  if ((kind === 'capture' || kind === 'refund') && typeof record.paymentId === 'string') {
    return { kind, key, startedAt, paymentId: record.paymentId };
  }
  return null;
}

/**
 * Sends an action and records what the answer means for it: a definite
 * answer clears it; a 202 keeps it, and for a create also remembers the
 * payment it reserved; an uncertain answer keeps it as it was.
 */
export async function runPending(
  api: Pick<ApiClient, 'post'>,
  store: PendingActions,
  action: PendingAction,
): Promise<Attempt> {
  const attempt = await sendPending(api, action);
  if (attempt.kind === 'done' || attempt.kind === 'refused') {
    store.clear(action);
  } else if (attempt.kind === 'unresolved' && action.kind === 'create') {
    store.replace({ ...action, paymentId: attempt.body.payment.id });
  }
  return attempt;
}

export type CreateResult =
  | Attempt
  /** Storage refused the record, so nothing was sent: without it a lost answer couldn't be retried safely. */
  | { kind: 'not_saved' }
  /** The answer came after the page was left; the store is updated, the page must do nothing. */
  | { kind: 'left' };

/**
 * Sends a create that is already saved (a new one, or one sent again with its
 * original key) and reports the outcome only while the page is still active.
 */
export async function finishCreate(
  api: Pick<ApiClient, 'post'>,
  store: PendingActions,
  action: Extract<PendingAction, { kind: 'create' }>,
  isActive: () => boolean,
): Promise<CreateResult> {
  const attempt = await runPending(api, store, action);
  return isActive() ? attempt : { kind: 'left' };
}

/** A new create: saved under a new key first, and sent only if the save succeeded. */
export function submitCreate(
  api: Pick<ApiClient, 'post'>,
  store: PendingActions,
  input: CreateInput,
  options: { key: string; now: Date; isActive: () => boolean },
): Promise<CreateResult> {
  const action: Extract<PendingAction, { kind: 'create' }> = {
    kind: 'create',
    key: options.key,
    input,
    paymentId: null,
    startedAt: options.now.toISOString(),
  };
  if (!store.save(action)) return Promise.resolve({ kind: 'not_saved' });
  return finishCreate(api, store, action, options.isActive);
}

/** What to tell the merchant when the browser won't keep the recovery record. */
export const NOT_SAVED_TEXT =
  'This browser couldn’t save the request, so it wasn’t sent: without that record a lost answer couldn’t be retried safely. Allow this site to store data (private browsing can block it) and try again.';
