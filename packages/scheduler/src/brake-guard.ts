// Somut güvenlik freni (docs/07 → Frenler).
//
// safety-brakes.ts'teki assert* fonksiyonları yazılmış ve test edilmişti ama
// hiçbir yerden çağrılmıyordu: token tavanı, maliyet tavanı, duvar saati ve
// kaçak döngü frenlerinin dördü de bağlı değildi. Bu modül onları veri
// kaynaklarına bağlar ve orkestratörün her deneme öncesi çağırdığı tek bir
// kontrol hâline getirir.
import type { Phase1BrakeCheck } from './phase1-orchestrator.js';
import {
  BrakeError,
  assertCostBudget,
  assertLoopSimilarity,
  assertTokenBudget,
  assertWallClock,
} from './safety-brakes.js';

export interface TaskBudgetSnapshot {
  tokensSpent: number;
  /** 0 = görev başına tavan yok. */
  tokenBudget: number;
  startedAtMs: number;
  /** Kullanıcı cevabı beklenerek geçen, işe sayılmayan süre (bkz. paused-waiting.ts). */
  pausedMs?: number;
}

export interface ProjectSpendSnapshot {
  spentUsd: number;
  /** 0 = sınırsız (projects.budget_usd_limit sözleşmesi). */
  limitUsd: number;
}

export interface BrakeGuardPorts {
  readTaskBudget: (taskId: string) => Promise<TaskBudgetSnapshot>;
  readProjectSpend: (taskId: string) => Promise<ProjectSpendSnapshot>;
  /** Son denemelerin hata metinleri; benzerlik kaçak döngüyü ele verir. */
  readRecentFailures: (taskId: string) => Promise<readonly string[]>;
  nowMs: () => number;
  wallClockLimitMs: number;
  /** Fren verisi okunamazsa iş durmaz ama hata sessizce kaybolmaz. */
  onError?: ((taskId: string, reason: unknown) => void) | undefined;
}

export function createBrakeGuard(ports: BrakeGuardPorts): Phase1BrakeCheck {
  return async ({ taskId }) => {
    try {
      const [budget, spend, failures] = await Promise.all([
        ports.readTaskBudget(taskId),
        ports.readProjectSpend(taskId),
        ports.readRecentFailures(taskId),
      ]);

      // Tavanı 0 olanlar "sınırsız" demektir; assert* fonksiyonları 0 tavanı
      // her zaman aşılmış sayacağı için bu durumlar önce elenir.
      if (budget.tokenBudget > 0) {
        assertTokenBudget({ spent: budget.tokensSpent, requested: 0, budget: budget.tokenBudget });
      }
      if (spend.limitUsd > 0) {
        assertCostBudget({ spentUsd: spend.spentUsd, requestedUsd: 0, budgetUsd: spend.limitUsd });
      }
      assertWallClock({
        startedAtMs: budget.startedAtMs,
        nowMs: ports.nowMs(),
        deadlineAtMs: budget.startedAtMs + ports.wallClockLimitMs,
        // Bekleme süresi işe sayılmaz: sayılırsa soru soran görev, kullanıcı
        // tavandan geç cevap verdiğinde cevabın hemen ardından fren yer.
        ...(budget.pausedMs === undefined ? {} : { pausedMs: budget.pausedMs }),
      });
      assertLoopSimilarity(failures);
    } catch (reason) {
      if (reason instanceof BrakeError) throw reason;
      // Gözlem katmanının hatası üretimi kilitlemesin.
      ports.onError?.(taskId, reason);
    }
  };
}
