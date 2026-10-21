import { Counter, Histogram, type Registry } from '@prometheus-io/client';

export interface HttpMetrics {
  requests: Counter<'method' | 'route' | 'status_class'>;
  duration: Histogram<'method' | 'route' | 'status_class'>;
}

/** Route label for requests that matched no route, so path guesses can't create new series. */
export const UNMATCHED_ROUTE = 'unmatched';

/** Request rate, errors (via status_class) and latency, labelled by route template. */
export function createHttpMetrics(registry: Registry): HttpMetrics {
  const labelNames = ['method', 'route', 'status_class'] as const;
  return {
    requests: new Counter({
      name: 'http_requests_total',
      help: 'HTTP requests handled, by method, route template and status class.',
      labelNames,
      registers: [registry],
    }),
    duration: new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request latency in seconds, by method, route template and status class.',
      labelNames,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [registry],
    }),
  };
}

export function statusClass(statusCode: number): string {
  return `${String(Math.floor(statusCode / 100))}xx`;
}
