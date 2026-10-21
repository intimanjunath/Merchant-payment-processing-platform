import { AsyncLocalStorage } from 'node:async_hooks';

/** Fields attached to every log line written while handling one request or job. */
export interface LogContext {
  requestId?: string;
  traceId?: string;
  spanId?: string;
  workerRunId?: string;
  jobId?: string;
  operationId?: string;
  paymentId?: string;
  merchantId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

/** Runs `fn` with `context` visible to every log call inside it, including after awaits. */
export function runWithContext<T>(context: LogContext, fn: () => T): T {
  return storage.run({ ...context }, fn);
}

export function getContext(): LogContext | undefined {
  return storage.getStore();
}

/** Adds fields to the current context, for values only known part-way through (like paymentId). */
export function addToContext(fields: LogContext): void {
  const current = storage.getStore();
  if (current) {
    Object.assign(current, fields);
  }
}
