import { Counter, createMetricsRegistry } from './metrics';

describe('createMetricsRegistry', () => {
  it('labels every metric with the service and includes process metrics', async () => {
    const registry = createMetricsRegistry('api');
    const counter = new Counter({
      name: 'test_events_total',
      help: 'Events seen by the test',
      labelNames: ['result'],
      registers: [registry],
    });
    counter.inc({ result: 'ok' });

    const text = await registry.metrics();

    expect(text).toContain('test_events_total{result="ok",service="api"} 1');
    expect(text).toMatch(/process_cpu_user_seconds_total\{service="api"\}/);
    expect(registry.contentType).toContain('text/plain');
  });

  it('keeps registries separate', async () => {
    const api = createMetricsRegistry('api');
    const worker = createMetricsRegistry('worker');
    new Counter({ name: 'only_in_api_total', help: 'x', registers: [api] }).inc();

    expect(await worker.metrics()).not.toContain('only_in_api_total');
  });
});
