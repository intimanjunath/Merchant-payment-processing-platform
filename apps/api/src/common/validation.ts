import { ValidationPipe } from '@nestjs/common';
import type { ValidationError } from 'class-validator';

import { ApiError } from './api-error';

export interface FieldIssue {
  field: string;
  issue: string;
}

/**
 * Flattens class-validator's errors into the spec's `details.fields` list
 * (spec §4.2). Messages name the field and the rule, never the value sent, so
 * a card number in an unknown field is not echoed back.
 */
export function fieldIssues(errors: ValidationError[], parent = ''): FieldIssue[] {
  const issues = errors.flatMap((error): FieldIssue[] => {
    const field = parent ? `${parent}.${error.property}` : error.property;
    const own = Object.entries(error.constraints ?? {}).map(([rule, message]) => ({
      field,
      issue: rule === 'whitelistValidation' ? 'is not an accepted field' : message,
    }));
    return [...own, ...fieldIssues(error.children ?? [], field)];
  });
  // Several rules can share one message (limit: integer, at least 1, at most 100); list it once.
  const seen = new Set<string>();
  return issues.filter(({ field, issue }) => {
    const key = `${field}\u0000${issue}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Unknown fields are rejected, not silently dropped: a field such as
 * cardNumber must fail loudly rather than be accepted and ignored.
 */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: (errors) =>
      new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed.', {
        details: { fields: fieldIssues(errors) },
      }),
  });
}
