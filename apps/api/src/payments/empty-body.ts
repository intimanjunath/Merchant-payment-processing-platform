import { ApiError } from '../common/api-error';

/**
 * Capture and refund take no body: none, or `{}`. Any field is rejected, the
 * same way unknown fields are rejected on create.
 */
export function assertEmptyBody(body: unknown): void {
  if (body === undefined || body === null) return;
  const fields = typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : ['body'];
  if (fields.length === 0) return;
  throw new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed.', {
    details: { fields: fields.map((field) => ({ field, issue: 'is not an accepted field' })) },
  });
}
