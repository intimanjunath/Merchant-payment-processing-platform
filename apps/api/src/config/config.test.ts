import { ConfigError, loadConfig } from './config';

const SECRET = 'x'.repeat(32);

function validEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    DATABASE_URL: 'postgres://user:pass@db:5432/payments',
    JWT_SECRET: SECRET,
    CSRF_SECRET: SECRET,
    CURSOR_SECRET: SECRET,
    ...overrides,
  };
}

function problemsFor(env: Record<string, string | undefined>): string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  throw new Error('expected loadConfig to fail');
}

describe('loadConfig', () => {
  it('uses the spec defaults when only the required values are set', () => {
    const config = loadConfig(validEnv());

    expect(config).toMatchObject({
      port: 3000,
      logLevel: 'info',
      sessionTtlSeconds: 28_800,
      cookieSecure: false,
      allowedOrigins: ['http://localhost:5173'],
      loginThrottle: { windowSeconds: 900, maxPerEmail: 5, maxPerIp: 50 },
      providerTimeoutMs: 5_000,
      jobs: { leaseSeconds: 30, maxRetries: 3, retryBaseMs: 2_000, reviewDeadlineSeconds: 1_800 },
      jwt: { issuer: 'payment-platform', audience: 'payment-platform-api' },
    });
  });

  it('parses overrides', () => {
    const config = loadConfig(
      validEnv({
        API_PORT: '8080',
        LOG_LEVEL: 'debug',
        COOKIE_SECURE: 'TRUE',
        ALLOWED_ORIGINS: 'https://a.example, https://b.example',
        LOGIN_THROTTLE_WINDOW_SECONDS: '2',
      }),
    );

    expect(config.port).toBe(8080);
    expect(config.logLevel).toBe('debug');
    expect(config.cookieSecure).toBe(true);
    expect(config.allowedOrigins).toEqual(['https://a.example', 'https://b.example']);
    expect(config.loginThrottle.windowSeconds).toBe(2);
  });

  it('reports every problem at once', () => {
    const problems = problemsFor({
      JWT_SECRET: 'short',
      API_PORT: 'eighty',
      COOKIE_SECURE: 'yes',
      LOG_LEVEL: 'loud',
    });

    expect(problems).toEqual(
      expect.arrayContaining([
        'DATABASE_URL is required',
        'JWT_SECRET must be at least 32 bytes',
        'CSRF_SECRET is required',
        'CURSOR_SECRET is required',
        'API_PORT must be an integer 1-65535',
        'COOKIE_SECURE must be true or false',
        expect.stringContaining('LOG_LEVEL must be one of'),
      ]),
    );
  });

  it('never echoes secret values in its messages', () => {
    const leaked = 'short-secret-value';
    const problems = problemsFor(validEnv({ JWT_SECRET: leaked }));

    expect(problems.join('\n')).not.toContain(leaked);
  });

  it('rejects a lease that cannot outlast a lookup plus a re-send', () => {
    expect(problemsFor(validEnv({ JOB_LEASE_SECONDS: '10', PROVIDER_TIMEOUT_MS: '5000' }))).toEqual(
      ['JOB_LEASE_SECONDS must be longer than two PROVIDER_TIMEOUT_MS periods'],
    );
    expect(() =>
      loadConfig(validEnv({ JOB_LEASE_SECONDS: '11', PROVIDER_TIMEOUT_MS: '5000' })),
    ).not.toThrow();
  });

  it('requires secure cookies in production', () => {
    expect(problemsFor(validEnv({ NODE_ENV: 'production' }))).toEqual([
      'COOKIE_SECURE must be true when NODE_ENV is production',
    ]);
    expect(loadConfig(validEnv({ NODE_ENV: 'production', COOKIE_SECURE: 'true' })).production).toBe(
      true,
    );
  });

  it('rejects a database URL that cannot be parsed', () => {
    expect(problemsFor(validEnv({ DATABASE_URL: 'not a url' }))).toEqual([
      'DATABASE_URL must be a valid URL',
    ]);
  });
});
