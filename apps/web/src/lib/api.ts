/** The API's error codes (design doc §4), plus NETWORK_ERROR when no answer came back. */
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
  | 'SERVICE_UNAVAILABLE'
  | 'NETWORK_ERROR';

export interface FieldIssue {
  field: string;
  issue: string;
}

/** An API error envelope (or a failure to reach the API), as one typed error. */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly requestId: string | null,
    readonly details: { fields?: FieldIssue[]; [key: string]: unknown } | undefined,
    /** Seconds from Retry-After, on 429 and some 503s. */
    readonly retryAfterSeconds: number | null,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

/** The session a request starts under: its CSRF token and its generation. */
export interface RequestSession {
  csrfToken: string | null;
  /** Identifies the session; a later sign-in gets a new one. */
  generation: number;
}

export interface ApiClientOptions {
  fetch: typeof fetch;
  /** Where the API is mounted on this origin (the dev proxy and the production web server use /api). */
  basePath: string;
  /** The current session, read once when a request starts. */
  session: () => RequestSession;
  /**
   * Called when the API says the session is no longer valid, with the session
   * the request started under, so a late answer can't end a newer session.
   */
  onUnauthenticated: (generation: number) => void;
}

export interface RequestOptions {
  body?: unknown;
  /** Required by create, capture and refund; generated once per action by the caller. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

const SAFE_METHODS = new Set(['GET', 'HEAD']);

/**
 * A thin JSON client for the payment API. Cookies travel automatically (same
 * origin); this adds the CSRF token to mutations, the Idempotency-Key when
 * given, and turns every failure into an ApiRequestError.
 */
export class ApiClient {
  constructor(private readonly options: ApiClientOptions) {}

  get<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('GET', path, options);
  }

  post<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('POST', path, options);
  }

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
    // Captured now: the answer may arrive after this session has been replaced.
    const session = this.options.session();
    if (session.csrfToken && !SAFE_METHODS.has(method)) headers['X-CSRF-Token'] = session.csrfToken;

    let response: Response;
    try {
      response = await this.options.fetch(`${this.options.basePath}${path}`, {
        method,
        headers,
        credentials: 'same-origin',
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new ApiRequestError(
        0,
        'NETWORK_ERROR',
        'The server could not be reached. Check your connection and try again.',
        null,
        undefined,
        null,
      );
    }

    if (response.status === 204) return undefined as T;
    const body: unknown = await response.json().catch(() => undefined);
    if (response.ok) return body as T;

    const error = toError(response, body);
    if (error.code === 'UNAUTHENTICATED') this.options.onUnauthenticated(session.generation);
    throw error;
  }
}

function toError(response: Response, body: unknown): ApiRequestError {
  const retryAfter = Number(response.headers.get('Retry-After'));
  const retryAfterSeconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null;
  const envelope = (body as { error?: Partial<Record<string, unknown>> } | undefined)?.error;
  if (envelope && typeof envelope.code === 'string' && typeof envelope.message === 'string') {
    return new ApiRequestError(
      response.status,
      envelope.code as ErrorCode,
      envelope.message,
      typeof envelope.requestId === 'string'
        ? envelope.requestId
        : response.headers.get('X-Request-Id'),
      envelope.details as ApiRequestError['details'],
      retryAfterSeconds,
    );
  }
  // No envelope (a proxy or gateway answered): describe it by status alone.
  return new ApiRequestError(
    response.status,
    response.status >= 500 ? 'SERVICE_UNAVAILABLE' : 'INTERNAL_ERROR',
    'The server returned an unexpected response. Try again in a moment.',
    response.headers.get('X-Request-Id'),
    undefined,
    retryAfterSeconds,
  );
}
