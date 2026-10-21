import { resolveRequestId } from './request-id';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('resolveRequestId', () => {
  it.each(['req-7f3a', 'abc.DEF:123_x-y', 'a'.repeat(64)])('keeps a safe id: %s', (id) => {
    expect(resolveRequestId(id)).toBe(id);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['too long', 'a'.repeat(65)],
    ['contains spaces', 'req 1'],
    ['log injection attempt', 'req-1\n{"level":"error"}'],
    ['repeated header', ['req-1', 'req-2']],
  ])('replaces %s with a generated id', (_label, incoming) => {
    expect(resolveRequestId(incoming)).toMatch(UUID);
  });
});
