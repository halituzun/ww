// Kontör panosu IO + sunum yardımcıları (docs/08 → Kontör Panosu).
import { getJsonOr, requestJson, type RequestOptions } from './http.js';

export type BudgetState = 'unlimited' | 'ok' | 'warning' | 'exceeded';

export interface BudgetReport {
  projectId: string;
  totals: {
    costUsd: number;
    promptTokens: number;
    completionTokens: number;
    calls: number;
    errors: number;
  };
  daily: { day: string; costUsd: number; calls: number }[];
  byModel: { providerId: string; model: string; costUsd: number; calls: number }[];
  topTasks: { taskId: string; costUsd: number; calls: number }[];
  budget: { state: BudgetState; ratio: number; spentUsd: number; limitUsd: number };
  windowDays: number;
}

export const EMPTY_BUDGET_REPORT: BudgetReport = {
  projectId: '',
  totals: { costUsd: 0, promptTokens: 0, completionTokens: 0, calls: 0, errors: 0 },
  daily: [], byModel: [], topTasks: [],
  budget: { state: 'unlimited', ratio: 0, spentUsd: 0, limitUsd: 0 },
  windowDays: 30,
};

export const fetchBudgetReport = (
  projectId: string,
  options: RequestOptions = {},
): Promise<BudgetReport> =>
  getJsonOr<BudgetReport>(
    `/projects/${encodeURIComponent(projectId)}/budget`,
    EMPTY_BUDGET_REPORT,
    options,
  );

// LLM maliyetleri çoğu zaman sent altındadır; iki basamağa yuvarlamak
// küçük tutarları '$0.00' yapıp bilgiyi yok eder.
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '$0.00';
  if (value > 0 && value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

export type Tone = 'good' | 'warning' | 'critical' | 'neutral';

/**
 * Durum rengi metinle birlikte gider: renk tek başına anlam taşımaz
 * (erişilebilirlik + docs/09 UI kontrol listesi).
 */
export function budgetTone(state: BudgetState): { tone: Tone; label: string } {
  switch (state) {
    case 'exceeded': return { tone: 'critical', label: 'Bütçe aşıldı' };
    case 'warning': return { tone: 'warning', label: 'Bütçe sınırına yaklaşıldı' };
    case 'ok': return { tone: 'good', label: 'Bütçe içinde' };
    default: return { tone: 'neutral', label: 'Bütçe sınırsız' };
  }
}

/**
 * Bütçe limitini düzenler (docs/08 → "bütçe düzenleme").
 *
 * NEDEN VAR: limit yalnızca proje oluşturulurken verilebiliyordu; sonradan
 * değiştirmenin yolu yoktu ve sınırsız açılmış bir projeye bütçe freni
 * panelden hiç kurulamıyordu.
 */
export interface BudgetLimitResult {
  limitUsd: number;
  spentUsd: number;
  alreadyExceeded: boolean;
}

export const setBudgetLimit = (
  projectId: string,
  limitUsd: number,
  options: RequestOptions = {},
): Promise<BudgetLimitResult> =>
  requestJson<BudgetLimitResult>(`/projects/${projectId}/budget`,
    { ...options, method: 'PATCH', body: { limitUsd } }, 'Bütçe limiti kaydedilemedi');
