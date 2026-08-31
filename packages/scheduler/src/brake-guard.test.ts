import { describe, expect, it, vi } from 'vitest';
import { BrakeError } from './safety-brakes.js';
import { createBrakeGuard, type BrakeGuardPorts } from './brake-guard.js';

const attempt = { attemptNumber: 1 } as never;
const context = { taskId: 't1', attempt, attemptNumber: 1 } as never;

function ports(over: Partial<BrakeGuardPorts> = {}): BrakeGuardPorts {
  return {
    readTaskBudget: async () => ({ tokensSpent: 0, tokenBudget: 1000, startedAtMs: 1_000 }),
    readProjectSpend: async () => ({ spentUsd: 0, limitUsd: 10 }),
    readRecentFailures: async () => [],
    nowMs: () => 2_000,
    wallClockLimitMs: 60_000,
    ...over,
  };
}

describe('createBrakeGuard', () => {
  it('sınırlar içindeyken geçer', async () => {
    await expect(createBrakeGuard(ports())(context)).resolves.toBeUndefined();
  });

  it('token tavanı aşılınca token_budget freni atar', async () => {
    const guard = createBrakeGuard(ports({
      readTaskBudget: async () => ({ tokensSpent: 1200, tokenBudget: 1000, startedAtMs: 1_000 }),
    }));
    await expect(guard(context)).rejects.toMatchObject({ kind: 'token_budget' });
  });

  it('proje bütçesi aşılınca cost_budget freni atar', async () => {
    const guard = createBrakeGuard(ports({
      readProjectSpend: async () => ({ spentUsd: 11, limitUsd: 10 }),
    }));
    await expect(guard(context)).rejects.toMatchObject({ kind: 'cost_budget' });
  });

  // docs/02: budget_usd_limit = 0 sınırsız demektir; fren atmamalı.
  it('limit 0 iken maliyet freni atmaz', async () => {
    const guard = createBrakeGuard(ports({
      readProjectSpend: async () => ({ spentUsd: 9999, limitUsd: 0 }),
    }));
    await expect(guard(context)).resolves.toBeUndefined();
  });

  it('token bütçesi 0 iken token freni atmaz', async () => {
    const guard = createBrakeGuard(ports({
      readTaskBudget: async () => ({ tokensSpent: 9999, tokenBudget: 0, startedAtMs: 1_000 }),
    }));
    await expect(guard(context)).resolves.toBeUndefined();
  });

  it('duvar saati aşılınca wall_clock freni atar', async () => {
    const guard = createBrakeGuard(ports({
      readTaskBudget: async () => ({ tokensSpent: 0, tokenBudget: 1000, startedAtMs: 1_000 }),
      nowMs: () => 1_000 + 120_000,
      wallClockLimitMs: 60_000,
    }));
    await expect(guard(context)).rejects.toMatchObject({ kind: 'wall_clock' });
  });

  it('aynı hata üç kez tekrarlanınca kaçak döngü freni atar', async () => {
    const guard = createBrakeGuard(ports({
      readRecentFailures: async () => [
        'TypeError: cannot read property x of undefined at line 12',
        'TypeError: cannot read property x of undefined at line 12',
        'TypeError: cannot read property x of undefined at line 12',
      ],
    }));
    await expect(guard(context)).rejects.toMatchObject({ kind: 'loop_similarity' });
  });

  it('farklı hatalar döngü freni atmaz', async () => {
    const guard = createBrakeGuard(ports({
      readRecentFailures: async () => ['alfa hatası', 'beta sorunu', 'gama arızası'],
    }));
    await expect(guard(context)).resolves.toBeUndefined();
  });

  // Fren okuması patlarsa iş DURMAMALI: gözlem hatası üretimi kilitlemesin,
  // ama sessizce de kaybolmasın.
  it('okuma hatasında geçirir ve bildirir', async () => {
    const onError = vi.fn();
    const guard = createBrakeGuard(ports({
      readProjectSpend: async () => { throw new Error('clickhouse düştü'); },
      onError,
    }));
    await expect(guard(context)).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('fren hatası okuma hatası sanılıp yutulmaz', async () => {
    const onError = vi.fn();
    const guard = createBrakeGuard(ports({
      onError,
      readProjectSpend: async () => ({ spentUsd: 11, limitUsd: 10 }),
    }));
    await expect(guard(context)).rejects.toBeInstanceOf(BrakeError);
    expect(onError).not.toHaveBeenCalled();
  });
});
