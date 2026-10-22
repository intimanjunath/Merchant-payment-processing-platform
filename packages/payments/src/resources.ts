import type { OperationRecord, PaymentRecord } from '@payments/db';

/** The Payment resource of spec §4.2. The payment-method token is never included. */
export function toPaymentResource(payment: PaymentRecord) {
  return {
    id: payment.id,
    state: payment.state,
    amount: payment.amountCents,
    currency: payment.currency,
    reference: payment.reference,
    paymentMethod: { brand: payment.cardBrand, last4: payment.cardLast4 },
    failureReason: payment.failureReason,
    settlementReview: payment.settlementReview,
    createdAt: payment.createdAt.toISOString(),
    updatedAt: payment.updatedAt.toISOString(),
  };
}

/** The Operation resource of spec §4.2. */
export function toOperationResource(operation: OperationRecord) {
  return {
    id: operation.id,
    action: operation.action,
    status: operation.status,
    reason: operation.reason,
    createdAt: operation.createdAt.toISOString(),
    completedAt: operation.completedAt?.toISOString() ?? null,
  };
}

/** What a mutation answers with: status and body, saved for replay once final. */
export interface MutationResponse {
  status: number;
  body: unknown;
}

/** 200, 201 and 202 all carry `{ payment, operation }` (spec §4.4). */
export function mutationResponse(
  status: number,
  payment: PaymentRecord,
  operation: OperationRecord,
): MutationResponse {
  return {
    status,
    body: { payment: toPaymentResource(payment), operation: toOperationResource(operation) },
  };
}

/**
 * A provider rejection of a capture or refund (422). The saved body is the
 * error without a request ID; the API adds the current request's ID when it
 * sends the envelope, also on replay.
 */
export function rejectionResponse(operation: OperationRecord, code: string): MutationResponse {
  return {
    status: 422,
    body: {
      error: {
        code: 'PROVIDER_REJECTED',
        message: 'The payment provider rejected the request.',
        details: { paymentId: operation.paymentId, operationId: operation.id, code },
      },
    },
  };
}
