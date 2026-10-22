import {
  completeJob,
  insertAuditEvent,
  insertSettlementJob,
  lockOperation,
  lockJob,
  lockPayment,
  markAwaitingConfirmation,
  type OperationAction,
  type OperationRecord,
  type OperationStatus,
  requeueJob,
  resolveOperation,
  saveOperationResponse,
  transitionPayment,
  withTransaction,
} from '@payments/db';
import type { Logger } from '@payments/observability';
import type { Pool, PoolClient } from 'pg';

import { mutationResponse, type MutationResponse, rejectionResponse } from './resources';
import {
  InvalidStateTransitionError,
  parsePaymentState,
  type PaymentEvent,
  type PaymentState,
  requiredState,
  transition,
} from './transitions';

/** A definitive provider answer, or (for authorize only) the provider having no record of it. */
export type FinalOutcome =
  | { outcome: 'succeeded'; chargeId: string }
  | { outcome: 'rejected'; code: string }
  | { outcome: 'not_received' };

export interface FinalizeDeps {
  pool: Pool;
  logger: Logger;
  /** Which process commits: recorded on audit rows. */
  source: 'api' | 'worker';
  /** Delay before the first settlement check after a capture. */
  settlementPollMs: number;
  reviewDeadlineSeconds: number;
}

/** The work being finished, and the lease generation the caller holds on its job. */
export interface WorkRef {
  paymentId: string;
  operationId: string;
  jobId: string;
  generation: number;
}

/**
 * The statements finalization runs, chosen from the action and the outcome
 * (spec §5.5). A transition changes the payment and adds one audit row; a
 * rejected capture or refund only resolves the operation.
 */
export type FinalizationPlan =
  | {
      kind: 'transition';
      event: PaymentEvent;
      operationStatus: 'succeeded' | 'rejected';
      operationReason: string | null;
      failureReason: string | null;
      providerPaymentId: string | null;
      httpStatus: 200 | 201;
      scheduleSettlement: boolean;
    }
  | { kind: 'rejection'; operationReason: 'capture_rejected' | 'refund_rejected'; code: string };

export function planFinalization(action: OperationAction, result: FinalOutcome): FinalizationPlan {
  if (action === 'authorize') {
    if (result.outcome === 'succeeded') {
      return {
        kind: 'transition',
        event: 'authorization_confirmed',
        operationStatus: 'succeeded',
        operationReason: null,
        failureReason: null,
        providerPaymentId: result.chargeId,
        httpStatus: 201,
        scheduleSettlement: false,
      };
    }
    const reason = result.outcome === 'rejected' ? result.code : 'authorization_not_received';
    // A create always answers 201 once the provider is definitive: the payment
    // exists, in state failed, with the reason.
    return {
      kind: 'transition',
      event: 'authorization_failed',
      operationStatus: 'rejected',
      operationReason: reason,
      failureReason: reason,
      providerPaymentId: null,
      httpStatus: 201,
      scheduleSettlement: false,
    };
  }

  if (result.outcome === 'not_received') {
    // Not final for capture or refund: recovery re-sends with the same key.
    throw new Error(`"not received" does not finalize a ${action}`);
  }
  if (result.outcome === 'rejected') {
    return { kind: 'rejection', operationReason: `${action}_rejected`, code: result.code };
  }
  return {
    kind: 'transition',
    event: action === 'capture' ? 'capture_confirmed' : 'refund_confirmed',
    operationStatus: 'succeeded',
    operationReason: null,
    failureReason: null,
    providerPaymentId: null,
    httpStatus: 200,
    scheduleSettlement: action === 'capture',
  };
}

export type FinalizeResult =
  | { kind: 'finalized'; response: MutationResponse }
  | { kind: 'already_final' }
  | { kind: 'lease_lost' }
  | { kind: 'version_conflict' };

const RESOLVED: readonly OperationStatus[] = ['succeeded', 'rejected'];

/**
 * TX2. Locks payment, then operation, then job, and writes nothing unless the
 * operation is still unresolved, the caller still holds the job at its lease
 * generation, and the payment is at the version and state the operation was
 * reserved against. Then, together: the payment change and its audit row (or,
 * for a rejected capture or refund, neither), the resolved operation with its
 * saved response, the completed job, and after a capture the settlement job.
 * No provider call happens here.
 */
export async function finalizeOperation(
  deps: FinalizeDeps,
  work: WorkRef,
  result: FinalOutcome,
): Promise<FinalizeResult> {
  let transitioned: { from: string; to: string } | undefined;

  const outcome = await withTransaction(deps.pool, async (client): Promise<FinalizeResult> => {
    const payment = await lockPayment(client, work.paymentId);
    const operation = await lockOperation(client, work.operationId);
    if (!payment || operation?.paymentId !== payment.id) {
      throw new Error('Finalize called for an operation that does not belong to the payment');
    }
    const ownership = await checkOwnership(client, work, operation);
    if (ownership) return { kind: ownership };
    if (payment.version !== operation.expectedVersion) return { kind: 'version_conflict' };

    const plan = planFinalization(operation.action, result);
    const state = parsePaymentState(payment.state);

    if (plan.kind === 'rejection') {
      const action = operation.action === 'refund' ? 'refund' : 'capture';
      if (state !== requiredState(action)) return { kind: 'version_conflict' };
      const resolved = await resolveOperation(client, {
        operationId: operation.id,
        status: 'rejected',
        reason: plan.operationReason,
      });
      const response = rejectionResponse(resolved, plan.code);
      await saveOperationResponse(client, operation.id, response);
      await completeJob(client, work.jobId);
      return { kind: 'finalized', response };
    }

    const rule = transitionFrom(state, plan.event);
    if (!rule) return { kind: 'version_conflict' };
    const updated = await transitionPayment(client, {
      paymentId: payment.id,
      expectedVersion: operation.expectedVersion,
      from: rule.from,
      to: rule.to,
      failureReason: plan.failureReason,
      providerPaymentId: plan.providerPaymentId,
    });
    if (!updated) return { kind: 'version_conflict' };

    await insertAuditEvent(client, {
      paymentId: payment.id,
      merchantId: payment.merchantId,
      fromState: rule.from,
      toState: rule.to,
      actor: `merchant:${payment.merchantId}`,
      source: deps.source,
      reason: plan.event,
      operationId: operation.id,
      requestId: operation.requestId,
    });
    const resolved = await resolveOperation(client, {
      operationId: operation.id,
      status: plan.operationStatus,
      reason: plan.operationReason,
    });
    const response = mutationResponse(plan.httpStatus, updated, resolved);
    await saveOperationResponse(client, operation.id, response);
    await completeJob(client, work.jobId);
    if (plan.scheduleSettlement) {
      await insertSettlementJob(client, {
        paymentId: payment.id,
        dueInMs: deps.settlementPollMs,
        reviewDeadlineSeconds: deps.reviewDeadlineSeconds,
        requestId: operation.requestId,
        traceparent: operation.traceparent,
      });
    }
    transitioned = { from: rule.from, to: rule.to };
    return { kind: 'finalized', response };
  });

  logFinalization(deps.logger, work, outcome, transitioned);
  return outcome;
}

export type ScheduleResult =
  | { kind: 'scheduled'; operation: OperationRecord }
  | { kind: 'already_final' }
  | { kind: 'lease_lost' };

/**
 * After a timeout or an unreachable provider the outcome is unknown. Locks
 * operation, then job (the payment is not touched), marks the operation
 * awaiting confirmation and hands the job back to the queue with its lease
 * cleared, so the worker looks the outcome up later.
 */
export async function scheduleRecovery(
  deps: Pick<FinalizeDeps, 'pool' | 'logger'>,
  work: WorkRef,
  failure: { reason: 'provider_timeout' | 'provider_unavailable'; delayMs: number },
): Promise<ScheduleResult> {
  const outcome = await withTransaction(deps.pool, async (client): Promise<ScheduleResult> => {
    const operation = await lockOperation(client, work.operationId);
    if (!operation) throw new Error('Operation to reschedule does not exist');
    const ownership = await checkOwnership(client, work, operation);
    if (ownership) return { kind: ownership };

    const awaiting = await markAwaitingConfirmation(client, operation.id, failure.reason);
    await requeueJob(client, {
      jobId: work.jobId,
      dueInMs: failure.delayMs,
      lastError: failure.reason,
    });
    return { kind: 'scheduled', operation: awaiting };
  });

  if (outcome.kind === 'scheduled') {
    deps.logger.warn(
      {
        event: 'operation.awaiting_confirmation',
        paymentId: work.paymentId,
        operationId: work.operationId,
        jobId: work.jobId,
        reason: failure.reason,
      },
      'Provider outcome unknown; recovery scheduled',
    );
  } else if (outcome.kind === 'lease_lost') {
    logLeaseLost(deps.logger, work);
  }
  return outcome;
}

/**
 * Locks the job (after payment and operation) and says why the caller must
 * stop, if it must. The lease generation decides first: a different one means
 * another owner claimed the job since, whatever state the operation is in, so
 * a late answer from an expired owner is always reported as a lost lease.
 * Only the current owner can see its own work as already final.
 */
async function checkOwnership(
  client: PoolClient,
  work: WorkRef,
  operation: OperationRecord,
): Promise<'lease_lost' | 'already_final' | undefined> {
  const job = await lockJob(client, work.jobId);
  if (job?.leaseGeneration !== work.generation) return 'lease_lost';
  if (RESOLVED.includes(operation.status) || job.status !== 'running') return 'already_final';
  return undefined;
}

/** Logged after commit, so a line never describes work that rolled back. */
function logFinalization(
  logger: Logger,
  work: WorkRef,
  outcome: FinalizeResult,
  transitioned: { from: string; to: string } | undefined,
): void {
  const ids = { paymentId: work.paymentId, operationId: work.operationId, jobId: work.jobId };
  if (outcome.kind === 'finalized' && transitioned) {
    logger.info(
      {
        event: 'payment.transitioned',
        ...ids,
        fromState: transitioned.from,
        toState: transitioned.to,
      },
      'Payment transitioned',
    );
  } else if (outcome.kind === 'lease_lost') {
    logLeaseLost(logger, work);
  } else if (outcome.kind === 'version_conflict') {
    logger.warn(
      { event: 'operation.version_conflict', ...ids },
      'Payment changed since the operation was reserved; nothing finalized',
    );
  } else if (outcome.kind === 'already_final') {
    logger.debug({ event: 'operation.already_final', ...ids }, 'Operation already finalized');
  }
}

function logLeaseLost(logger: Logger, work: WorkRef): void {
  logger.warn(
    {
      event: 'job.lease_lost',
      paymentId: work.paymentId,
      operationId: work.operationId,
      jobId: work.jobId,
      generation: work.generation,
    },
    'Job lease no longer held; result discarded',
  );
}

/** The transition for this event from the current state, or undefined if the state moved on. */
function transitionFrom(state: PaymentState, event: PaymentEvent) {
  try {
    return transition(state, event);
  } catch (error) {
    if (error instanceof InvalidStateTransitionError) return undefined;
    throw error;
  }
}
