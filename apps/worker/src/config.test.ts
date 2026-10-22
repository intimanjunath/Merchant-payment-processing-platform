import { ConfigError, loadWorkerConfig } from './config';

const base = { DATABASE_URL: 'postgres://user:pass@db:5432/payments' };

function problemsOf(env: Record<string, string>): string[] {
  try {
    loadWorkerConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  throw new Error('expected loadWorkerConfig to fail');
}

describe('loadWorkerConfig', () => {
  it('uses the spec defaults', () => {
    expect(loadWorkerConfig(base)).toMatchObject({
      healthPort: 3001,
      pollIntervalMs: 5_000,
      concurrency: 1,
      heartbeatIntervalMs: 10_000,
      shutdownGraceMs: 15_000,
      providerTimeoutMs: 5_000,
      jobs: { leaseSeconds: 30, maxRetries: 3, retryBaseMs: 2_000, reviewDeadlineSeconds: 1_800 },
    });
  });

  it('refuses a lease that does not outlast a lookup plus a re-send', () => {
    expect(problemsOf({ ...base, JOB_LEASE_SECONDS: '10', PROVIDER_TIMEOUT_MS: '5000' })).toEqual([
      'JOB_LEASE_SECONDS must be longer than two PROVIDER_TIMEOUT_MS periods',
    ]);
    expect(loadWorkerConfig({ ...base, JOB_LEASE_SECONDS: '11' }).jobs.leaseSeconds).toBe(11);
  });

  it('reports every problem at once, without echoing values', () => {
    const problems = problemsOf({
      DATABASE_URL: 'not a url',
      WORKER_CONCURRENCY: '0',
      LOG_LEVEL: 'loud',
    });

    expect(problems).toEqual(
      expect.arrayContaining([
        'DATABASE_URL must be a valid URL',
        'WORKER_CONCURRENCY must be an integer 1-64',
        expect.stringContaining('LOG_LEVEL must be one of'),
      ]),
    );
    expect(problems.join(' ')).not.toContain('not a url');
  });
});
