import { createHmac } from 'node:crypto';

import { decodeCursor, encodeCursor, type ListFilters } from './cursor';
import { InvalidCursorError } from './errors';

const SECRET = 'cursor-test-secret-0123456789abcdef';
const filters: ListFilters = {
  merchantId: '0192f0b1-0000-7000-8000-000000000001',
  state: null,
  search: null,
};
const position = {
  createdAt: '2026-10-21T17:04:05.123456Z',
  id: '0192f0c4-7a1e-7c3b-9a8d-2f4b6c8e1a20',
};

/** A cursor with any payload, correctly signed, to test what is checked after the signature. */
function signed(payload: unknown, secret = SECRET): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

const refused =
  (cursor: string, with_: ListFilters = filters, secret = SECRET) =>
  () =>
    decodeCursor(secret, cursor, with_);

describe('cursor', () => {
  it('round-trips the position, microseconds included', () => {
    expect(decodeCursor(SECRET, encodeCursor(SECRET, position, filters), filters)).toEqual(
      position,
    );
  });

  it.each([
    ['another merchant', { ...filters, merchantId: '0192f0b1-0000-7000-8000-000000000002' }],
    ['another status', { ...filters, state: 'captured' }],
    ['a status where there was none', { ...filters, state: 'authorized' }],
    ['another search', { ...filters, search: 'abd' }],
  ])('is refused for %s', (_label, other) => {
    expect(refused(encodeCursor(SECRET, position, filters), other)).toThrow(InvalidCursorError);
  });

  it('is refused when signed with another secret', () => {
    expect(refused(encodeCursor('another-secret-0123456789abcdef0123', position, filters))).toThrow(
      InvalidCursorError,
    );
  });

  it('is refused when the payload is changed but the signature kept', () => {
    const [, signature] = encodeCursor(SECRET, position, filters).split('.');
    const forged = Buffer.from(
      JSON.stringify({ v: 1, ...position, id: position.id.replace('a20', 'a21') }),
    ).toString('base64url');

    expect(refused(`${forged}.${String(signature)}`)).toThrow(InvalidCursorError);
  });

  it('is refused when one character of the signature changes', () => {
    const cursor = encodeCursor(SECRET, position, filters);
    const last = cursor.at(-1) === 'A' ? 'B' : 'A';

    expect(refused(cursor.slice(0, -1) + last)).toThrow(InvalidCursorError);
  });

  it.each(['', 'abc', 'a.b.c', 'abc.', '.abc', '!!!.@@@', 'eyJ2IjoxfQ'])(
    'is refused when malformed: %j',
    (cursor) => {
      expect(refused(cursor)).toThrow(InvalidCursorError);
    },
  );

  it.each([
    ['another version', { v: 2, ...position }],
    ['millisecond precision', { v: 1, ...position, createdAt: '2026-10-21T17:04:05.123Z' }],
    ['a malformed ID', { v: 1, ...position, id: 'not-a-uuid' }],
    ['no filter hash', { v: 1, ...position }],
    ['not an object', 'cursor'],
  ])('is refused, even correctly signed, with %s', (_label, payload) => {
    expect(refused(signed(payload))).toThrow(InvalidCursorError);
  });
});
