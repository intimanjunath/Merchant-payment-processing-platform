/** Error codes from the spec's error table (design doc §4). */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'INVALID_CREDENTIALS'
  | 'UNAUTHENTICATED'
  | 'CSRF_REJECTED'
  | 'NOT_FOUND'
  | 'INVALID_STATE_TRANSITION'
  | 'OPERATION_IN_PROGRESS'
  | 'IDEMPOTENCY_CONFLICT'
  | 'PROVIDER_REJECTED'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'
  | 'SERVICE_UNAVAILABLE';

export interface ApiErrorOptions {
  details?: Record<string, unknown>;
  /** Extra response headers, such as Retry-After for 429 and 503. */
  headers?: Record<string, string>;
}

/** An error the API means to return to the client, with a status and a stable code. */
export class ApiError extends Error {
  readonly details: Record<string, unknown> | undefined;
  readonly headers: Record<string, string>;

  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    options: ApiErrorOptions = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.details = options.details;
    this.headers = options.headers ?? {};
  }
}
