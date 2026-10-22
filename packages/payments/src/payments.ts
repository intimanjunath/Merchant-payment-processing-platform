import {
  findOperation,
  findPayment,
  type JobRecord,
  type OperationRecord,
  type PaymentRecord,
} from '@payments/db';
import type { PaymentProvider, ProviderResult } from '@payments/provider';

import { WorkMismatchError } from './errors';
import { type FinalizeDeps, finalizeOperation, scheduleRecovery, type WorkRef } from './finalize';
import {
  type CreateInput,
  type MutationContext,
  type Reservation,
  type ReservationDeps,
  reserveAction,
  reserveCreate,
} from './reservation';
import { countJobRunOnce, type JobRunOutcome } from './metrics';
import { callProvider, isProviderFailure, type ProviderFailure } from './provider-call';
import { mutationResponse, type MutationResponse } from './resources';

const callIds = (operation: OperationRecord, call: string) => ({
  paymentId: operation.paymentId,
  operationId: operation.id,
  action: operation.action,
  call,
});

export interface PaymentDeps extends ReservationDeps, FinalizeDeps {
  provider: PaymentProvider;
  /** How long after a timeout or unreachable provider the worker should look the outcome up. */
  recoveryDelayMs: number;
}

type ProviderCall = ProviderResult | ProviderFailure;

/** POST /payments: reserve, authorize with nothing locked, then finalize or schedule recovery. */
export async function createPayment(
  deps: PaymentDeps,
  context: MutationContext,
  input: CreateInput,
): Promise<MutationResponse> {
  const reservation = await reserveCreate(deps, context, input);
  if (reservation.kind === 'replay') return replayResponse(reservation);

  const { payment, operation } = reservation;
  return runOwnJob(deps, reservation, 'authorize', () =>
    deps.provider.authorize({
      providerKey: operation.providerKey,
      token: payment.paymentMethodToken,
      amountCents: payment.amountCents,
    }),
  );
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
  return runOwnJob(deps, { payment, operation, job }, input.action, () =>
    input.action === 'capture' ? deps.provider.capture(request) : deps.provider.refund(request),
  );
}

/**
 * The API's own run of the operation's recovery job: the provider call, then
 * finalize or reschedule. Counted in job_runs_total exactly once, like a
 * worker's run: by its result, or as failed if anything in it throws.
 */
async function runOwnJob(
  deps: PaymentDeps,
  reserved: { payment: PaymentRecord; operation: OperationRecord; job: JobRecord },
  callName: string,
  send: () => Promise<ProviderResult>,
): Promise<MutationResponse> {
  const count = countJobRunOnce(deps, 'operation_recovery');
  try {
    const call = await callProvider(deps, callIds(reserved.operation, callName), send);
    return await conclude(deps, reserved, call, count);
  } catch (error) {
    count('failed');
    throw error;
  }
}

/** After the call: finalize a definitive answer, or schedule recovery for an unknown one. */
async function conclude(
  deps: PaymentDeps,
  reserved: { payment: PaymentRecord; operation: OperationRecord; job: JobRecord },
  call: ProviderCall,
  count: (outcome: JobRunOutcome) => void,
): Promise<MutationResponse> {
  const work: WorkRef = {
    paymentId: reserved.payment.id,
    operationId: reserved.operation.id,
    jobId: reserved.job.id,
    generation: reserved.job.leaseGeneration,
  };

  if (isProviderFailure(call)) {
    const scheduled = await scheduleRecovery(deps, work, {
      reason: call.failure,
      delayMs: deps.recoveryDelayMs,
    });
    count(scheduled.kind);
  } else {
    const result = await finalizeOperation(deps, work, call);
    count(result.kind);
    if (result.kind === 'finalized') return result.response;
  }
  // Scheduled, or someone else got there first: answer with what is stored now.
  return currentResponse(work);

  async function currentResponse(ref: WorkRef): Promise<MutationResponse> {
    const [payment, operation] = await Promise.all([
      findPayment(deps.pool, ref.paymentId),
      findOperation(deps.pool, ref.operationId),
    ]);
    if (!payment || !operation) {
      throw new WorkMismatchError(`reserved work for operation ${ref.operationId} is missing`);
    }
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
