export type PaymentErrorCode =
  'IDEMPOTENCY_CONFLICT' | 'NOT_FOUND' | 'OPERATION_IN_PROGRESS' | 'VALIDATION_ERROR';

/** A refusal the API maps to its error envelope; the code matches the design doc's table. */
export class PaymentError extends Error {
  constructor(
    readonly code: PaymentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class IdempotencyConflictError extends PaymentError {
  constructor(readonly operationId: string) {
    super(
      'IDEMPOTENCY_CONFLICT',
      'This idempotency key was already used with a different request.',
    );
  }
}

export class OperationInProgressError extends PaymentError {
  constructor(readonly operationId: string) {
    super('OPERATION_IN_PROGRESS', 'Another action on this payment is still being processed.');
  }
}

export class PaymentNotFoundError extends PaymentError {
  constructor() {
    super('NOT_FOUND', 'Payment not found.');
  }
}

/** Bad input the payments package can only judge itself, reported against one field. */
export class InvalidInputError extends PaymentError {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super('VALIDATION_ERROR', message);
  }
}

export class UnknownPaymentMethodError extends InvalidInputError {
  constructor() {
    super('paymentMethod', 'is not a recognized payment method');
  }
}

/** Tampered, malformed, or issued for another merchant or other filters. */
export class InvalidCursorError extends InvalidInputError {
  constructor() {
    super('cursor', 'is not valid for this query');
  }
}
