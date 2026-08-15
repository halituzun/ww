import { describe, expect, it } from 'vitest';
import { selectMemoryChunks } from './memory-service.js';

const chunk = (sourceId: string, text: string, score: number) => ({
  sourceTable: 'knowledge' as const,
  sourceId: sourceId as never,
  text,
  label: `[knowledge #${sourceId}]`,
  score,
});

describe('Phase 2 memory budget', () => {
  it('whole chunks kullanir, duplicate kaynagi eler ve deterministic siralar', () => {
    const result = selectMemoryChunks([
      chunk('00000000-0000-0000-0000-000000000002', 'low priority context', 1),
      chunk('00000000-0000-0000-0000-000000000001', 'high priority decision', 4),
      chunk('00000000-0000-0000-0000-000000000001', 'high priority decision', 4),
    ], 5);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.sourceId).toBe('00000000-0000-0000-0000-000000000001');
    expect(result.estimatedTokens).toBeGreaterThan(0);
  });

  it('gecersiz ve asiri token butcesini fail-closed reddeder', () => {
    expect(() => selectMemoryChunks([], 0)).toThrow(/token budget/);
    expect(() => selectMemoryChunks([], 100_001)).toThrow(/token budget/);
  });
});
