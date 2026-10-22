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

  const { payment, operation, job } = reservation;
  const call = await callProvider(deps.logger, callIds(operation, 'authorize'), () =>
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
  const call = await callProvider(deps.logger, callIds(operation, input.action), () =>
    input.action === 'capture' ? deps.provider.capture(request) : deps.provider.refund(request),
  );
  return conclude(deps, { payment, operation, job }, call);
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

  if (isProviderFailure(call)) {
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
