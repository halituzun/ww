import { describe, expect, it } from 'vitest';
import { BrakeError, assertCostBudget, assertLoopSimilarity, assertTokenBudget, assertWallClock } from './safety-brakes.js';

describe('scheduler safety brakes', () => {
  it('enforces token and cost budgets', () => {
    expect(() => assertTokenBudget({ spent: 9, requested: 2, budget: 10 })).toThrow(BrakeError);
    expect(() => assertCostBudget({ spentUsd: 1, requestedUsd: 0.2, budgetUsd: 1 })).toThrow(BrakeError);
  });
  it('stops wall clock overruns and repeated loops', () => {
    expect(() => assertWallClock({ startedAtMs: 0, nowMs: 11, deadlineAtMs: 10 })).toThrow(BrakeError);
    expect(() => assertLoopSimilarity(['same answer', 'same answer', 'same answer'])).toThrow(BrakeError);
    expect(() => assertLoopSimilarity(['one', 'two', 'three'])).not.toThrow();
  });
});
