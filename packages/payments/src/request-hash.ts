import { createHash } from 'node:crypto';

/**
 * SHA-256 hex of the validated input serialized with sorted keys, so JSON
 * property order never changes the hash. Inputs are flat objects.
 */
export function requestHash(input: Readonly<Record<string, string | number>>): string {
  const canonical = JSON.stringify(input, Object.keys(input).sort());
  return createHash('sha256').update(canonical).digest('hex');
}

/** Create: `{ amount, reference (trimmed), paymentMethod }` (spec §4.4). */
export function createRequestHash(input: {
  amount: number;
  reference: string;
  paymentMethod: string;
}): string {
  return requestHash({
    amount: input.amount,
    reference: input.reference.trim(),
    paymentMethod: input.paymentMethod,
  });
}

/** Capture and refund: `{ action, paymentId }` (spec §4.4). */
export function actionRequestHash(input: { action: string; paymentId: string }): string {
  return requestHash({ action: input.action, paymentId: input.paymentId });
}
