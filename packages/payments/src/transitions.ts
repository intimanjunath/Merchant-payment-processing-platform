export const PAYMENT_STATES = [
  'pending',
  'authorized',
  'captured',
  'settled',
  'failed',
  'refunded',
] as const;
export type PaymentState = (typeof PAYMENT_STATES)[number];

/** A payment exists from the moment its create request is accepted. */
export const INITIAL_STATE: PaymentState = 'pending';

/** Confirmed outcomes that move a payment to its next state. */
export const PAYMENT_EVENTS = [
  'authorization_confirmed',
  'authorization_failed',
  'capture_confirmed',
  'settlement_confirmed',
  'refund_confirmed',
] as const;
export type PaymentEvent = (typeof PAYMENT_EVENTS)[number];

/** Mutations a merchant can request on an existing payment. */
export const PAYMENT_ACTIONS = ['capture', 'refund'] as const;
export type PaymentAction = (typeof PAYMENT_ACTIONS)[number];

/** Who initiated a transition; the audit row records `merchant:<id>` or `system:settlement`. */
export type TransitionActor = 'merchant' | 'system:settlement';

export interface Transition {
  from: PaymentState;
  to: PaymentState;
  actor: TransitionActor;
}

/**
 * The whole lifecycle (spec §3.1). It is linear: each event has one source
 * state and each state is entered at most once, which is what lets
 * audit_events keep one row per (payment, to_state).
 */
const TRANSITIONS: Readonly<Record<PaymentEvent, Transition>> = {
  authorization_confirmed: { from: 'pending', to: 'authorized', actor: 'merchant' },
  authorization_failed: { from: 'pending', to: 'failed', actor: 'merchant' },
  capture_confirmed: { from: 'authorized', to: 'captured', actor: 'merchant' },
  settlement_confirmed: { from: 'captured', to: 'settled', actor: 'system:settlement' },
  refund_confirmed: { from: 'settled', to: 'refunded', actor: 'merchant' },
};

/** The event that confirms each requested action. */
const CONFIRMED_BY: Readonly<Record<PaymentAction, PaymentEvent>> = {
  capture: 'capture_confirmed',
  refund: 'refund_confirmed',
};

export class InvalidStateTransitionError extends Error {
  readonly code = 'INVALID_STATE_TRANSITION';

  constructor(
    readonly state: PaymentState,
    readonly attempted: PaymentEvent | PaymentAction,
  ) {
    super(`A payment in state ${state} does not allow ${attempted}.`);
    this.name = 'InvalidStateTransitionError';
  }
}

/**
 * Applies a confirmed outcome; any pair not in the table is refused. Returns a
 * copy, so a caller changing the result cannot change the rules.
 */
export function transition(state: PaymentState, event: PaymentEvent): Transition {
  const rule = TRANSITIONS[event];
  if (rule.from !== state) throw new InvalidStateTransitionError(state, event);
  return { ...rule };
}

/** The state an action must start from: capture needs authorized, refund needs settled. */
export function requiredState(action: PaymentAction): PaymentState {
  return TRANSITIONS[CONFIRMED_BY[action]].from;
}

/** Checked under the payment lock before an action is reserved. */
export function assertActionAllowed(state: PaymentState, action: PaymentAction): void {
  if (requiredState(action) !== state) throw new InvalidStateTransitionError(state, action);
}
