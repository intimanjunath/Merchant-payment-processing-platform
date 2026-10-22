import { describe, expect, it } from 'vitest';

import { clearMerchantRecords, recordKey } from './browser-records';

/** A minimal in-memory Storage. */
function memoryStorage(initial: Record<string, string>): Storage {
  const items = new Map(Object.entries(initial));
  return {
    get length() {
      return items.size;
    },
    key: (index: number) => [...items.keys()][index] ?? null,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
    removeItem: (key: string) => {
      items.delete(key);
    },
    clear: () => {
      items.clear();
    },
  };
}

describe('clearMerchantRecords', () => {
  it("removes every record of the signed-out merchant and nobody else's", () => {
    const storage = memoryStorage({
      [recordKey('m-1', 'pending:create')]: '{}',
      [recordKey('m-1', 'pending:capture:p-1')]: '{}',
      [recordKey('m-2', 'pending:create')]: '{}',
      'unrelated-key': 'x',
    });

    clearMerchantRecords(storage, 'm-1');

    expect(storage.getItem(recordKey('m-1', 'pending:create'))).toBeNull();
    expect(storage.getItem(recordKey('m-1', 'pending:capture:p-1'))).toBeNull();
    expect(storage.getItem(recordKey('m-2', 'pending:create'))).toBe('{}');
    expect(storage.getItem('unrelated-key')).toBe('x');
  });

  it('does not treat a merchant ID as a prefix of a longer one', () => {
    const storage = memoryStorage({ [recordKey('m-10', 'pending:create')]: '{}' });

    clearMerchantRecords(storage, 'm-1');

    expect(storage.length).toBe(1);
  });
});
