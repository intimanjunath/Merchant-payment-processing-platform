import { InvalidInputError, InvalidStateTransitionError, PaymentError } from '@payments/payments';

import { ApiError } from '../common/api-error';

/**
 * Turns the payments package's refusals into the API's error table (design
 * doc §4). Anything else is rethrown unchanged for the exception filter.
 */
export function toApiError(error: unknown): unknown {
  if (error instanceof InvalidStateTransitionError) {
    return new ApiError(
      409,
      'INVALID_STATE_TRANSITION',
      'This action is not allowed for the payment in its current state.',
      {
        details: { state: error.state },
      },
    );
  }
  if (error instanceof InvalidInputError) {
    return new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed.', {
      details: { fields: [{ field: error.field, issue: error.message }] },
    });
  }
  if (!(error instanceof PaymentError)) return error;

  switch (error.code) {
    case 'NOT_FOUND':
      return new ApiError(404, 'NOT_FOUND', 'The requested resource was not found.');
    case 'IDEMPOTENCY_CONFLICT':
      return new ApiError(409, 'IDEMPOTENCY_CONFLICT', error.message);
    case 'OPERATION_IN_PROGRESS':
      return new ApiError(409, 'OPERATION_IN_PROGRESS', error.message);
    case 'VALIDATION_ERROR':
      return new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed.');
  }
}
