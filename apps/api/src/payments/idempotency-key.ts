import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

import { ApiError } from '../common/api-error';

// 1-128 printable ASCII characters, no spaces (spec §4.1); UUIDs qualify.
const IDEMPOTENCY_KEY = /^[\x21-\x7E]{1,128}$/;

/** The request's Idempotency-Key, required on create, capture and refund. */
export const IdempotencyKey = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const value = context.switchToHttp().getRequest<Request>().headers['idempotency-key'];
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY.test(value)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed.', {
      details: {
        fields: [
          {
            field: 'Idempotency-Key',
            issue: 'required header of 1 to 128 printable ASCII characters without spaces',
          },
        ],
      },
    });
  }
  return value;
});
