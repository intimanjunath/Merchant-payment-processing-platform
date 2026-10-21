import { HttpException } from '@nestjs/common';

import { ApiError, type ErrorCode } from './api-error';

export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    requestId: string;
    details?: Record<string, unknown>;
  };
}

export interface ErrorResponse {
  status: number;
  body: ErrorBody;
  headers: Record<string, string>;
  /** True when the error was not one the API meant to return; callers log these. */
  unexpected: boolean;
}

// Generic messages for errors raised by the framework rather than our own code.
// They never echo the request (paths, parser output), only what went wrong.
const FRAMEWORK_ERRORS: Record<number, { code: ErrorCode; message: string }> = {
  400: { code: 'VALIDATION_ERROR', message: 'The request is not valid.' },
  401: { code: 'UNAUTHENTICATED', message: 'Authentication is required.' },
  403: { code: 'CSRF_REJECTED', message: 'The request was rejected.' },
  404: { code: 'NOT_FOUND', message: 'The requested resource was not found.' },
  405: { code: 'NOT_FOUND', message: 'The requested resource was not found.' },
  413: { code: 'VALIDATION_ERROR', message: 'The request body is too large.' },
  415: { code: 'VALIDATION_ERROR', message: 'The request body must be JSON.' },
  429: { code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' },
  503: { code: 'SERVICE_UNAVAILABLE', message: 'The service is temporarily unavailable.' },
};

const INTERNAL: { code: ErrorCode; message: string } = {
  code: 'INTERNAL_ERROR',
  message: 'Something went wrong. Quote the request ID if you contact support.',
};

/** Maps anything thrown while handling a request to the API's error envelope. */
export function toErrorResponse(exception: unknown, requestId: string): ErrorResponse {
  if (exception instanceof ApiError) {
    return build(exception.status, exception.code, exception.message, requestId, {
      details: exception.details,
      headers: exception.headers,
    });
  }

  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const known = FRAMEWORK_ERRORS[status];
    if (known) {
      return build(status, known.code, known.message, requestId, {
        details: status === 400 ? validationDetails(exception) : undefined,
      });
    }
    if (status < 500) {
      return build(status, 'VALIDATION_ERROR', FRAMEWORK_ERRORS[400]?.message ?? '', requestId);
    }
    return { ...build(500, INTERNAL.code, INTERNAL.message, requestId), unexpected: true };
  }

  const parserError = bodyParserClientError(exception);
  if (parserError) {
    return build(parserError.status, 'VALIDATION_ERROR', parserError.message, requestId);
  }

  return { ...build(500, INTERNAL.code, INTERNAL.message, requestId), unexpected: true };
}

function build(
  status: number,
  code: ErrorCode,
  message: string,
  requestId: string,
  extra: { details?: Record<string, unknown> | undefined; headers?: Record<string, string> } = {},
): ErrorResponse {
  return {
    status,
    body: {
      error: { code, message, requestId, ...(extra.details ? { details: extra.details } : {}) },
    },
    headers: extra.headers ?? {},
    unexpected: false,
  };
}

/** Keeps the field messages from Nest's ValidationPipe, which are about the client's input. */
function validationDetails(exception: HttpException): Record<string, unknown> | undefined {
  const response = exception.getResponse();
  if (typeof response === 'object' && 'message' in response && Array.isArray(response.message)) {
    const issues = response.message.filter((item): item is string => typeof item === 'string');
    return issues.length > 0 ? { issues } : undefined;
  }
  return undefined;
}

// body-parser's client-side failures, by error `type`, with the status it sets:
// https://github.com/expressjs/body-parser#errors. Its other types
// (stream.encoding.set, stream.not.readable) are server bugs and stay 500.
const BODY_PARSER_CLIENT_ERRORS: Record<string, string> = {
  'entity.parse.failed': 'The request body is not valid JSON.',
  'entity.too.large': 'The request body is too large.',
  'entity.verify.failed': 'The request body was rejected.',
  'request.aborted': 'The request body was not fully received.',
  'request.size.invalid': 'The request body does not match its Content-Length.',
  'charset.unsupported': 'The request body uses an unsupported charset.',
  'encoding.unsupported': 'The request body uses an unsupported Content-Encoding.',
};

export function isBodyParserError(exception: unknown): boolean {
  return bodyParserClientError(exception) !== undefined;
}

function bodyParserClientError(
  exception: unknown,
): { status: number; message: string } | undefined {
  if (typeof exception !== 'object' || exception === null) return undefined;
  const { status, type } = exception as { status?: unknown; type?: unknown };
  if (typeof type !== 'string' || typeof status !== 'number') return undefined;
  const message = BODY_PARSER_CLIENT_ERRORS[type];
  if (message === undefined || status < 400 || status >= 500) return undefined;
  return { status, message };
}
