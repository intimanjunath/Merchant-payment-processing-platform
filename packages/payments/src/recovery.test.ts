import { retryDelayMs } from './recovery';

describe('retryDelayMs', () => {
  it('doubles from the base: 2, 4 and 8 s by default, at the middle of the jitter', () => {
    expect([1, 2, 3].map((failures) => retryDelayMs(failures, 2_000, () => 0.5))).toEqual([
      2_000, 4_000, 8_000,
    ]);
  });

  it('stays within ±20% of the nominal delay', () => {
    expect(retryDelayMs(1, 2_000, () => 0)).toBe(1_600);
    expect(retryDelayMs(1, 2_000, () => 0.999999)).toBe(2_400);
    for (let i = 0; i < 100; i += 1) {
      const delay = retryDelayMs(3, 2_000);
      expect(delay).toBeGreaterThanOrEqual(6_400);
      expect(delay).toBeLessThanOrEqual(9_600);
    }
  });
});
