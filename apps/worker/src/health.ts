import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { checkReadiness } from '@payments/db';
import {
  createHttpMetrics,
  type Logger,
  type Registry,
  resolveRequestId,
  statusClass,
  UNMATCHED_ROUTE,
} from '@payments/observability';
import type { Pool } from 'pg';

import type { Heartbeat } from './heartbeat';

export interface HealthServerOptions {
  pool: Pool;
  logger: Logger;
  metrics: Registry;
  heartbeat: Heartbeat;
  readinessTimeoutMs: number;
  /** True once shutdown began: readiness turns 503 so no one routes new work here. */
  isShuttingDown: () => boolean;
}

type Route = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/**
 * The worker's only HTTP surface (spec §4.5): /health, /ready and /metrics,
 * with the same request IDs and RED metrics as the API.
 */
export function createHealthServer(options: HealthServerOptions): Server {
  const http = createHttpMetrics(options.metrics);
  const routes: Record<string, Route> = {
    '/health': (_req, res) => {
      const stale = options.heartbeat.isStale();
      send(res, stale ? 503 : 200, {
        status: stale ? 'stale' : 'ok',
        lastHeartbeatAt: options.heartbeat.lastBeatAt.toISOString(),
      });
      return Promise.resolve();
    },
    '/ready': async (_req, res) => {
      const shuttingDown = options.isShuttingDown();
      const result = await checkReadiness(options.pool, {
        logger: options.logger,
        timeoutMs: options.readinessTimeoutMs,
      });
      const ready = result.ready && !shuttingDown;
      send(res, ready ? 200 : 503, {
        status: ready ? 'ready' : 'not_ready',
        checks: result.checks,
        shuttingDown,
      });
    },
    '/metrics': async (_req, res) => {
      const body = await options.metrics.metrics();
      res.writeHead(200, {
        'Content-Type': options.metrics.contentType,
        'Cache-Control': 'no-store',
      });
      res.end(body);
    },
  };

  return createServer((req, res) => {
    const startedAt = process.hrtime.bigint();
    const requestId = resolveRequestId(req.headers['x-request-id']);
    res.setHeader('X-Request-Id', requestId);
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    const route = req.method === 'GET' ? routes[path] : undefined;
    const routeLabel = route ? path : UNMATCHED_ROUTE;

    res.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      const labels = {
        method: req.method ?? 'GET',
        route: routeLabel,
        status_class: statusClass(res.statusCode),
      };
      http.requests.inc(labels);
      http.duration.observe(labels, seconds);
      const fields = {
        event: 'http.request.completed',
        requestId,
        ...labels,
        status: res.statusCode,
      };
      // Probes arrive every few seconds; only failures are worth more than debug.
      options.logger[res.statusCode >= 500 ? 'warn' : 'debug'](fields, 'Request completed');
    });

    if (!route) {
      send(res, 404, {
        error: { code: 'NOT_FOUND', message: 'The requested resource was not found.', requestId },
      });
      return;
    }
    route(req, res).catch((error: unknown) => {
      options.logger.error(
        { event: 'http.request.failed', requestId, err: error },
        'Health route failed',
      );
      if (!res.headersSent) {
        send(res, 500, {
          error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.', requestId },
        });
      }
    });
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
