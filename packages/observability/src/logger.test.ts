import { Writable } from 'node:stream';

import { runOutsideContext, runWithContext } from './context';
import { createLogger, type LogLevel } from './logger';
import { REDACTED } from './redact';

function capture(level: LogLevel = 'debug') {
  const lines: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      done();
    },
  });
  const logger = createLogger({ service: 'test', level, destination });
  return { logger, lines };
}

describe('createLogger', () => {
  it('writes one JSON object per line with time, level label and service', () => {
    const { logger, lines } = capture();
    logger.info({ event: 'payment.transitioned' }, 'Payment captured');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'info',
      service: 'test',
      event: 'payment.transitioned',
      msg: 'Payment captured',
    });
    expect(Date.parse(String(lines[0]?.time))).not.toBeNaN();
  });

  it('respects the configured level', () => {
    const { logger, lines } = capture('warn');
    logger.info('routine');
    logger.warn('worth a look');

    expect(lines.map((line) => line.msg)).toEqual(['worth a look']);
  });

  it('redacts sensitive fields at any depth, keeping everything else', () => {
    const { logger, lines } = capture();
    logger.info({
      event: 'auth.login.failed',
      email: 'merchant1@example.test',
      req: {
        headers: {
          authorization: 'Bearer eyJhbGciOi',
          cookie: 'pp_session=abc',
          'x-request-id': 'req-1',
        },
      },
      body: { password: 'hunter2', nested: { deeper: { csrfToken: 'c', amount: 1500 } } },
      payment: { paymentMethod: 'pm_card_visa', payment_method_token: 'pm_card_visa' },
      cards: [{ cardNumber: '4242424242424242', cvv: '123', last4: '4242' }],
      config: { JWT_SECRET: 's', apiToken: 't' },
    });

    const line = lines[0] as Record<string, any>;
    expect(line.email).toBe('merchant1@example.test');
    expect(line.req.headers).toEqual({
      authorization: REDACTED,
      cookie: REDACTED,
      'x-request-id': 'req-1',
    });
    expect(line.body.password).toBe(REDACTED);
    expect(line.body.nested.deeper).toEqual({ csrfToken: REDACTED, amount: 1500 });
    expect(line.payment).toEqual({ paymentMethod: REDACTED, payment_method_token: REDACTED });
    expect(line.cards).toEqual([{ cardNumber: REDACTED, cvv: REDACTED, last4: '4242' }]);
    expect(line.config).toEqual({ JWT_SECRET: REDACTED, apiToken: REDACTED });
    expect(JSON.stringify(line)).not.toMatch(/hunter2|eyJhbGciOi|4242424242424242|pm_card_visa/);
  });

  it('redacts fields inside serialized errors and their causes', () => {
    const { logger, lines } = capture();
    const cause = Object.assign(new Error('upstream refused'), { accessToken: 'tok-1' });
    const error = Object.assign(new Error('provider call failed', { cause }), {
      code: 'PROVIDER_TIMEOUT',
      request: { headers: { authorization: 'Bearer secret-jwt' } },
    });

    logger.error({ err: error, event: 'provider.call.completed' }, 'Provider call failed');

    const line = lines[0] as Record<string, any>;
    expect(line.err).toMatchObject({
      type: 'Error',
      message: expect.stringContaining('provider call failed'),
      code: 'PROVIDER_TIMEOUT',
      request: { headers: { authorization: REDACTED } },
    });
    expect(typeof line.err.stack).toBe('string');
    expect(JSON.stringify(line)).not.toMatch(/secret-jwt|tok-1/);
  });

  it('handles an error passed as the only argument', () => {
    const { logger, lines } = capture();
    logger.error(Object.assign(new Error('boom'), { password: 'p' }));

    const line = lines[0] as Record<string, any>;
    expect(line.msg).toBe('boom');
    expect(line.err.password).toBe(REDACTED);
  });

  it('redacts sensitive fields bound to child loggers, including nested children', () => {
    const { logger, lines } = capture();
    const child = logger
      .child({ password: 'sample-secret', merchant: 'acme' })
      .child({ req: { headers: { authorization: 'Bearer child-jwt', 'x-request-id': 'req-9' } } })
      .child({ session: { nested: { csrfToken: 'csrf-child' } }, attempt: 2 });

    child.info({ event: 'job.claimed' }, 'event');

    const line = lines[0] as Record<string, any>;
    expect(line).toMatchObject({
      service: 'test',
      password: REDACTED,
      merchant: 'acme',
      req: { headers: { authorization: REDACTED, 'x-request-id': 'req-9' } },
      session: { nested: { csrfToken: REDACTED } },
      attempt: 2,
      event: 'job.claimed',
    });
    expect(JSON.stringify(line)).not.toMatch(/sample-secret|child-jwt|csrf-child/);
  });

  it('redacts child bindings when child options are passed too', () => {
    const { logger, lines } = capture('warn');
    // pino takes a different code path in child() when options are given.
    logger.child({ apiToken: 'opt-token', job: 'settle' }, { level: 'debug' }).debug('polled');

    expect(lines[0]).toMatchObject({ apiToken: REDACTED, job: 'settle', level: 'debug' });
    expect(JSON.stringify(lines[0])).not.toContain('opt-token');
  });

  it('redacts errors and secrets added later with setBindings', () => {
    const { logger, lines } = capture();
    const child = logger.child({ step: 'recovery' });
    child.setBindings({
      cause: Object.assign(new Error('lookup failed'), { accessToken: 'bound-token' }),
      config: { JWT_SECRET: 'bound-secret' },
    });

    child.warn('retrying');

    const line = lines[0] as Record<string, any>;
    expect(line.step).toBe('recovery');
    expect(line.cause.accessToken).toBe(REDACTED);
    expect(line.config.JWT_SECRET).toBe(REDACTED);
    expect(JSON.stringify(line)).not.toMatch(/bound-token|bound-secret/);
  });

  it('does not modify the bindings object passed to child()', () => {
    const { logger } = capture();
    const bindings = { req: { headers: { authorization: 'Bearer keep-me' } } };
    logger.child(bindings).info('event');

    expect(bindings.req.headers.authorization).toBe('Bearer keep-me');
  });

  it('does not modify the object that was logged', () => {
    const { logger } = capture();
    const fields = { body: { password: 'hunter2' } };
    logger.info(fields);

    expect(fields.body.password).toBe('hunter2');
  });

  it('copes with circular references', () => {
    const { logger, lines } = capture();
    const node: Record<string, unknown> = { name: 'loop' };
    node.self = node;

    expect(() => {
      logger.info({ node });
    }).not.toThrow();
    expect((lines[0] as Record<string, any>).node).toEqual({ name: 'loop', self: '[Circular]' });
  });

  it('adds the current request context to every line', async () => {
    const { logger, lines } = capture();

    await runWithContext({ requestId: 'req-42', traceId: 'a'.repeat(32) }, async () => {
      logger.info('before await');
      await new Promise((resolve) => setImmediate(resolve));
      logger.info('after await');
    });
    logger.info('outside');

    expect(lines[0]).toMatchObject({ requestId: 'req-42', traceId: 'a'.repeat(32) });
    expect(lines[1]).toMatchObject({ requestId: 'req-42' });
    expect(lines[2]).not.toHaveProperty('requestId');
  });

  it('logs background events without the context of whichever request is in scope', () => {
    const { logger, lines } = capture();

    runWithContext({ requestId: 'req-unrelated', traceId: 'b'.repeat(32) }, () => {
      runOutsideContext(() => {
        logger.warn({ event: 'db.pool.idle_client_error' }, 'Idle database connection lost');
      });
      logger.info('still inside');
    });

    expect(lines[0]).not.toHaveProperty('requestId');
    expect(lines[0]).not.toHaveProperty('traceId');
    expect(lines[1]).toMatchObject({ requestId: 'req-unrelated' });
  });
});
