import { formatTraceparent, parseTraceparent, startSpan } from './trace';

const VALID = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

describe('traceparent', () => {
  it('round-trips a valid header', () => {
    const parsed = parseTraceparent(VALID);

    expect(parsed).toEqual({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
      flags: '01',
    });
    expect(parsed && formatTraceparent(parsed)).toBe(VALID);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['upper-case hex', VALID.toUpperCase()],
    ['short trace id', '00-4bf92f3577b34da6a3ce929d0e0e473-00f067aa0ba902b7-01'],
    ['all-zero trace id', `00-${'0'.repeat(32)}-00f067aa0ba902b7-01`],
    ['all-zero span id', `00-4bf92f3577b34da6a3ce929d0e0e4736-${'0'.repeat(16)}-01`],
    ['forbidden version ff', 'ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'],
    ['extra field on version 00', `${VALID}-extra`],
    ['not a traceparent', 'hello'],
  ])('rejects %s', (_label, header) => {
    expect(parseTraceparent(header)).toBeUndefined();
  });

  it('accepts a future version with extra fields, keeping the known ones', () => {
    expect(
      parseTraceparent('01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-future'),
    ).toEqual({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
      flags: '01',
    });
  });
});

describe('startSpan', () => {
  it('continues the parent trace with a new span id', () => {
    const parent = parseTraceparent(VALID);
    const span = startSpan(parent);

    expect(span.traceId).toBe(parent?.traceId);
    expect(span.flags).toBe(parent?.flags);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(span.spanId).not.toBe(parent?.spanId);
  });

  it('starts a new sampled trace without a parent', () => {
    const span = startSpan();

    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(span.flags).toBe('01');
    expect(parseTraceparent(formatTraceparent(span))).toEqual(span);
  });
});
