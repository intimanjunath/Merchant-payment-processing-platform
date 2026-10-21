import { collectDefaultMetrics, Registry } from '@prometheus-io/client';

export { Counter, Gauge, Histogram, Registry } from '@prometheus-io/client';

/**
 * One registry per process, labelled with the service name. Includes Node's
 * default process metrics (CPU, memory, event loop lag, GC).
 */
export function createMetricsRegistry(service: string): Registry {
  const registry = new Registry();
  registry.setDefaultLabels({ service });
  collectDefaultMetrics({ register: registry });
  return registry;
}
