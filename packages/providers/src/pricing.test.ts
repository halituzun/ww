import { expect, it } from 'vitest';
import { costUsd } from './pricing.js';

it('bilinen model için maliyet hesaplar', () => {
  const r = costUsd('anthropic:claude-sonnet-5', { promptTokens: 1_000_000, completionTokens: 1_000_000 });
  expect(r.known).toBe(true);
  expect(r.cost).toBeCloseTo(3 + 15, 6);
});

it('bilinmeyen model 0 + known:false döner', () => {
  const r = costUsd('acme:mystery-1', { promptTokens: 1000, completionTokens: 1000 });
  expect(r).toEqual({ cost: 0, known: false });
});
