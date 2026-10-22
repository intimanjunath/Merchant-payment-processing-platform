import {
  formatTraceparent,
  type HttpMetrics,
  type Logger,
  parseTraceparent,
  REQUEST_ID_HEADER,
  resolveRequestId,
  runWithContext,
  startSpan,
  statusClass,
  TRACEPARENT_HEADER,
  UNMATCHED_ROUTE,
} from '@payments/observability';
import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';

import { isBodyParserError, toErrorResponse } from './error-response';

interface RequestLocals {
  requestId: string;
  traceId: string;
  spanId: string;
  traceFlags: string;
}

// Probes and scrapes arrive every few seconds; logging them at info would bury real traffic.
const QUIET_ROUTES = new Set(['/health', '/ready', '/metrics']);

/**
 * First middleware on every request. Assigns the request ID (echoed in
 * X-Request-Id) and a trace span, then logs and measures the request when the
 * response finishes. It runs before body parsing so even malformed bodies are
 * tracked.
 */
export function trackRequests(logger: Logger, metrics: HttpMetrics): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const startedAt = process.hrtime.bigint();
    const span = startSpan(parseTraceparent(req.get(TRACEPARENT_HEADER)));
    const locals: RequestLocals = {
      requestId: resolveRequestId(req.headers[REQUEST_ID_HEADER]),
      traceId: span.traceId,
      spanId: span.spanId,
      traceFlags: span.flags,
    };
    Object.assign(res.locals, locals);
    res.setHeader('X-Request-Id', locals.requestId);

    res.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      const route = routeTemplate(req);
      const labels = { method: req.method, route, status_class: statusClass(res.statusCode) };
      metrics.requests.inc(labels);
      metrics.duration.observe(labels, seconds);

      // Logged with explicit IDs: 'finish' fires outside the request's async context.
      const fields = {
        event: 'http.request.completed',
        requestId: locals.requestId,
        traceId: locals.traceId,
        spanId: locals.spanId,
        method: req.method,
        route,
        status: res.statusCode,
        durationMs: Math.round(seconds * 1000),
      };
      logger[levelFor(res.statusCode, route)](fields, 'Request completed');
    });

    next();
  };
}

/**
 * Runs the rest of the request inside the async logging context. Mounted after
 * the body parser, because the parser resumes on stream events that would drop
 * a context bound earlier.
 */
export const bindRequestContext: RequestHandler = (_req, res, next) => {
  const { requestId, traceId, spanId } = res.locals as Partial<RequestLocals>;
  runWithContext({ requestId, traceId, spanId }, next);
};

/**
 * Answers malformed or oversized bodies straight after the JSON parser. Left to
 * Nest, these become a generic BadRequestException carrying the parser's own
 * message, which can't be told apart from other bad requests.
 */
export const handleBodyParserErrors: ErrorRequestHandler = (error: unknown, _req, res, next) => {
  if (!isBodyParserError(error)) {
    next(error);
    return;
  }
  const result = toErrorResponse(error, requestIdOf(res));
  res.status(result.status).set(result.headers).json(result.body);
};

export function requestIdOf(res: Response): string {
  const { requestId } = res.locals as Partial<RequestLocals>;
  return requestId ?? 'unknown';
}

/**
 * This request's span as a traceparent, stored on the work it creates so the
 * worker's later spans link back to it.
 */
export function traceparentOf(res: Response): string | null {
  const { traceId, spanId, traceFlags } = res.locals as Partial<RequestLocals>;
  if (!traceId || !spanId || !traceFlags) return null;
  return formatTraceparent({ traceId, spanId, flags: traceFlags });
}

function routeTemplate(req: Request): string {
  // Express sets req.route once a route matches; its type is `any`, so narrow it here.
  const route: unknown = (req as { route?: unknown }).route;
  if (typeof route === 'object' && route !== null && 'path' in route) {
    const { path } = route;
    if (typeof path === 'string') return `${req.baseUrl}${path}`;
  }
  return UNMATCHED_ROUTE;
}

function levelFor(status: number, route: string): 'debug' | 'info' | 'warn' | 'error' {
  // A failing probe is an expected state that orchestrators act on, polled every
  // few seconds during an outage; at error level it would flood the error log.
  if (QUIET_ROUTES.has(route)) return status >= 500 ? 'warn' : 'debug';
  if (status >= 500) return 'error';
  if (status >= 400 && status !== 401 && status !== 404) return 'warn';
  return 'info';
}
