import { isDatabaseUnavailable } from './errors';

const withCode = (code: string) => Object.assign(new Error('failed'), { code });

describe('isDatabaseUnavailable', () => {
  it.each([
    ['a refused connection', withCode('ECONNREFUSED')],
    ['a reset connection', withCode('ECONNRESET')],
    ['an unknown host', withCode('ENOTFOUND')],
    ['a connection exception (SQLSTATE class 08)', withCode('08006')],
    ['a server shutting down', withCode('57P01')],
    ['a server still starting', withCode('57P03')],
    ['a pool connect timeout', new Error('timeout exceeded when trying to connect')],
    ['a dropped connection', new Error('Connection terminated unexpectedly')],
    ['an ended pool', new Error('Cannot use a pool after calling end on the pool')],
    ['refusals to every address', new AggregateError([withCode('ECONNREFUSED')], 'failed')],
  ])('recognizes %s', (_label, error) => {
    expect(isDatabaseUnavailable(error)).toBe(true);
  });

  it.each([
    ['a unique violation', withCode('23505')],
    ['a syntax error', withCode('42601')],
    ['a statement timeout', withCode('57014')],
    ['a plain error', new Error('boom')],
    ['a non-error', 'ECONNREFUSED'],
    ['null', null],
  ])('does not treat %s as unavailability', (_label, error) => {
    expect(isDatabaseUnavailable(error)).toBe(false);
  });
});
