import { describe, expect, it } from 'vitest';
import { fileLockEventSequence } from './file-lock-events.js';

describe('file lock event sequence', () => {
  it('epoch aninda acquired/released kilitleri nonnegative ve collision-free siralar', () => {
    const createdAt = '1970-01-01T00:00:00.000Z';
    const first = Array.from({ length: 4 }, (_, index) => [
      fileLockEventSequence(createdAt, index, 'lock_released'),
      fileLockEventSequence(createdAt, index, 'lock_acquired'),
    ]).flat();
    const replay = Array.from({ length: 4 }, (_, index) => [
      fileLockEventSequence(createdAt, index, 'lock_released'),
      fileLockEventSequence(createdAt, index, 'lock_acquired'),
    ]).flat();

    expect(first).toEqual(['0', '1', '2', '3', '4', '5', '6', '7']);
    expect(replay).toEqual(first);
    expect(new Set(first).size).toBe(first.length);
    expect(first.every((value) => BigInt(value) >= 0n)).toBe(true);
  });

  it('gecersiz tarih ve indexi event repositorysine ulasmadan reddeder', () => {
    expect(() => fileLockEventSequence('invalid', 0, 'lock_acquired')).toThrow(
      /createdAt gecersiz/,
    );
    expect(() => fileLockEventSequence('1970-01-01T00:00:00.000Z', -1, 'lock_released'))
      .toThrow(/index gecersiz/);
  });
});
