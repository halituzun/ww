export type BrakeKind = 'token_budget' | 'cost_budget' | 'loop_similarity' | 'wall_clock';

export class BrakeError extends Error {
  readonly kind: BrakeKind;
  constructor(kind: BrakeKind, message: string) {
    super(message);
    this.name = 'BrakeError';
    this.kind = kind;
  }
}

export function assertTokenBudget(input: { readonly spent: number; readonly requested: number; readonly budget: number }): void {
  if (![input.spent, input.requested, input.budget].every(Number.isFinite) || input.spent < 0 || input.requested < 0 || input.budget < 0 || input.spent + input.requested > input.budget) {
    throw new BrakeError('token_budget', 'token butcesi asildi');
  }
}

export function assertCostBudget(input: { readonly spentUsd: number; readonly requestedUsd: number; readonly budgetUsd: number }): void {
  if (![input.spentUsd, input.requestedUsd, input.budgetUsd].every(Number.isFinite) || input.spentUsd < 0 || input.requestedUsd < 0 || input.budgetUsd < 0 || input.spentUsd + input.requestedUsd > input.budgetUsd) {
    throw new BrakeError('cost_budget', 'maliyet butcesi asildi');
  }
}

export function assertWallClock(input: { readonly startedAtMs: number; readonly nowMs: number; readonly deadlineAtMs: number }): void {
  if (!Number.isFinite(input.startedAtMs) || !Number.isFinite(input.nowMs) || !Number.isFinite(input.deadlineAtMs) || input.nowMs < input.startedAtMs || input.nowMs > input.deadlineAtMs) {
    throw new BrakeError('wall_clock', 'duvar saati limiti asildi');
  }
}

export function assertLoopSimilarity(history: readonly string[], threshold = 0.92): void {
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) throw new BrakeError('loop_similarity', 'gecersiz benzerlik esigi');
  const recent = history.slice(-3).map(normalize);
  if (recent.length < 3) return;
  const score = (a: string, b: string): number => {
    const left = new Set(a.split(' '));
    const right = new Set(b.split(' '));
    const intersection = [...left].filter((word) => right.has(word)).length;
    return intersection / Math.max(1, new Set([...left, ...right]).size);
  };
  if (score(recent[0]!, recent[1]!) >= threshold && score(recent[1]!, recent[2]!) >= threshold) {
    throw new BrakeError('loop_similarity', 'tekrarlayan cikti dongusu algilandi');
  }
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase('en-US').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ');
}
