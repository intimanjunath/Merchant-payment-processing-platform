import {
  findOperation,
  findPayment,
  type JobRecord,
  type OperationRecord,
  type PaymentRecord,
} from '@payments/db';
import {
  type PaymentProvider,
  type ProviderResult,
  ProviderTimeoutError,
  ProviderUnavailableError,
} from '@payments/provider';

import { type FinalizeDeps, finalizeOperation, scheduleRecovery, type WorkRef } from './finalize';
import {
  type CreateInput,
  type MutationContext,
  type Reservation,
  type ReservationDeps,
  reserveAction,
  reserveCreate,
} from './reservation';
import { mutationResponse, type MutationResponse } from './resources';

export interface PaymentDeps extends ReservationDeps, FinalizeDeps {
  provider: PaymentProvider;
  /** How long after a timeout or unreachable provider the worker should look the outcome up. */
  recoveryDelayMs: number;
}

type ProviderCall = ProviderResult | { failure: 'provider_timeout' | 'provider_unavailable' };

/** POST /payments: reserve, authorize with nothing locked, then finalize or schedule recovery. */
export async function createPayment(
  deps: PaymentDeps,
  context: MutationContext,
  input: CreateInput,
): Promise<MutationResponse> {
  const reservation = await reserveCreate(deps, context, input);
  if (reservation.kind === 'replay') return replayResponse(reservation);

  const { payment, operation, job } = reservation;
  const call = await callProvider(deps, operation, () =>
    deps.provider.authorize({
      providerKey: operation.providerKey,
      token: payment.paymentMethodToken,
      amountCents: payment.amountCents,
    }),
  );
  return conclude(deps, { payment, operation, job }, call);
}

/** POST /payments/{id}/capture. */
export function capturePayment(
  deps: PaymentDeps,
  context: MutationContext,
  input: { paymentId: string },
): Promise<MutationResponse> {
  return runAction(deps, context, { paymentId: input.paymentId, action: 'capture' });
}

/** POST /payments/{id}/refund. */
export function refundPayment(
  deps: PaymentDeps,
  context: MutationContext,
  input: { paymentId: string },
): Promise<MutationResponse> {
  return runAction(deps, context, { paymentId: input.paymentId, action: 'refund' });
}

async function runAction(
  deps: PaymentDeps,
  context: MutationContext,
  input: { paymentId: string; action: 'capture' | 'refund' },
): Promise<MutationResponse> {
  const reservation = await reserveAction(deps, context, input);
  if (reservation.kind === 'replay') return replayResponse(reservation);

  const { payment, operation, job } = reservation;
  const chargeId = payment.providerPaymentId;
  if (!chargeId) throw new Error('An authorized payment has no provider payment ID');
  const request = {
    providerKey: operation.providerKey,
    chargeId,
    amountCents: payment.amountCents,
  };
  const call = await callProvider(deps, operation, () =>
    input.action === 'capture' ? deps.provider.capture(request) : deps.provider.refund(request),
  );
  return conclude(deps, { payment, operation, job }, call);
}

/**
 * Runs one provider call. No transaction is open and no row is locked while
 * it runs. Timeouts and transport failures become "outcome unknown"; any
 * other error propagates, and the leased job lets the worker recover after
 * the lease expires.
 */
async function callProvider(
  deps: PaymentDeps,
  operation: OperationRecord,
  call: () => Promise<ProviderResult>,
): Promise<ProviderCall> {
  const started = performance.now();
  const ids = {
    paymentId: operation.paymentId,
    operationId: operation.id,
    action: operation.action,
  };
  const durationMs = () => Math.round(performance.now() - started);
  try {
    const result = await call();
    deps.logger.debug(
      {
        event: 'provider.call.completed',
        ...ids,
        outcome: result.outcome,
        durationMs: durationMs(),
      },
      'Provider call completed',
    );
    return result;
  } catch (error) {
    const failure =
      error instanceof ProviderTimeoutError
        ? 'provider_timeout'
        : error instanceof ProviderUnavailableError
          ? 'provider_unavailable'
          : undefined;
    if (!failure) throw error;
    deps.logger.warn(
      { event: 'provider.call.completed', ...ids, outcome: failure, durationMs: durationMs() },
      'Provider call failed; outcome unknown',
    );
    return { failure };
  }
}

/** After the call: finalize a definitive answer, or schedule recovery for an unknown one. */
async function conclude(
  deps: PaymentDeps,
  reserved: { payment: PaymentRecord; operation: OperationRecord; job: JobRecord },
  call: ProviderCall,
): Promise<MutationResponse> {
  const work: WorkRef = {
    paymentId: reserved.payment.id,
    operationId: reserved.operation.id,
    jobId: reserved.job.id,
    generation: reserved.job.leaseGeneration,
  };

  if ('failure' in call) {
    await scheduleRecovery(deps, work, { reason: call.failure, delayMs: deps.recoveryDelayMs });
  } else {
    const result = await finalizeOperation(deps, work, call);
    if (result.kind === 'finalized') return result.response;
  }
  // Scheduled, or someone else got there first: answer with what is stored now.
  return currentResponse(work);

  async function currentResponse(ref: WorkRef): Promise<MutationResponse> {
    const [payment, operation] = await Promise.all([
      findPayment(deps.pool, ref.paymentId),
      findOperation(deps.pool, ref.operationId),
    ]);
    if (!payment || !operation) throw new Error('Reserved work disappeared');
    return replayResponse({ kind: 'replay', payment, operation });
  }
}

/** A resolved operation answers with its saved response; an unresolved one with 202 and the current state. */
function replayResponse(replay: Extract<Reservation, { kind: 'replay' }>): MutationResponse {
  const { payment, operation } = replay;
  if (operation.responseStatus !== null) {
    return { status: operation.responseStatus, body: operation.responseBody };
  }
  return mutationResponse(202, payment, operation);
}
