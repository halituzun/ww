// Kontör raporu (docs/08 → Kontör Panosu, docs/04 → Kontör).
// api_usage üzerinden proje kapsamlı toplam, günlük seri, sağlayıcı/model
// kırılımı ve en pahalı görevler.
import type { ClickHouseClient } from '@clickhouse/client';

export interface UsageTotals {
  costUsd: number;
  promptTokens: number;
  completionTokens: number;
  calls: number;
  errors: number;
}

export interface DailyUsagePoint {
  day: string;
  costUsd: number;
  calls: number;
}

export interface ModelUsageSlice {
  providerId: string;
  model: string;
  costUsd: number;
  calls: number;
}

export interface TaskCostSlice {
  taskId: string;
  costUsd: number;
  calls: number;
}

export interface UsageReport {
  projectId: string;
  totals: UsageTotals;
  daily: DailyUsagePoint[];
  byModel: ModelUsageSlice[];
  topTasks: TaskCostSlice[];
}

export type BudgetState = 'unlimited' | 'ok' | 'warning' | 'exceeded';

export interface BudgetStatus {
  state: BudgetState;
  ratio: number;
  spentUsd: number;
  limitUsd: number;
}

/** docs/04: tavanın %80'inde uyarı, tavanda durdurma. */
export const BUDGET_WARNING_RATIO = 0.8;

export function budgetStatus(spentUsd: number, limitUsd: number): BudgetStatus {
  if (!Number.isFinite(spentUsd) || spentUsd < 0) throw new Error('gecersiz harcama tutari');
  if (!Number.isFinite(limitUsd) || limitUsd < 0) throw new Error('gecersiz butce limiti');

  // 0 = sınırsız (projects.budget_usd_limit sözleşmesi).
  if (limitUsd === 0) return { state: 'unlimited', ratio: 0, spentUsd, limitUsd };

  const ratio = spentUsd / limitUsd;
  const state: BudgetState = ratio >= 1 ? 'exceeded' : ratio >= BUDGET_WARNING_RATIO ? 'warning' : 'ok';
  return { state, ratio, spentUsd, limitUsd };
}

const num = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

export async function readUsageReport(
  ch: ClickHouseClient,
  projectId: string,
  options: { days?: number; topTaskLimit?: number } = {},
): Promise<UsageReport> {
  const days = options.days ?? 30;
  const topTaskLimit = options.topTaskLimit ?? 10;
  if (!Number.isSafeInteger(days) || days < 1 || days > 365) throw new Error('gecersiz gun araligi');
  if (!Number.isSafeInteger(topTaskLimit) || topTaskLimit < 1 || topTaskLimit > 100) {
    throw new Error('gecersiz gorev limiti');
  }

  const params = { projectId, days, topTaskLimit };

  const [totalsRows, dailyRows, modelRows, taskRows] = await Promise.all([
    ch.query({
      query: `SELECT sum(cost_usd) AS cost_usd, sum(prompt_tokens) AS prompt_tokens,
        sum(completion_tokens) AS completion_tokens, count() AS calls,
        countIf(status != 'ok') AS errors
        FROM api_usage WHERE project_id = {projectId:UUID}`,
      query_params: params, format: 'JSONEachRow',
    }).then((r) => r.json<Record<string, unknown>>()),

    ch.query({
      query: `SELECT toDate(created_at) AS day, sum(cost_usd) AS cost_usd, count() AS calls
        FROM api_usage
        WHERE project_id = {projectId:UUID} AND created_at >= now() - toIntervalDay({days:UInt16})
        GROUP BY day ORDER BY day ASC`,
      query_params: params, format: 'JSONEachRow',
    }).then((r) => r.json<Record<string, unknown>>()),

    ch.query({
      query: `SELECT provider_id, model, sum(cost_usd) AS cost_usd, count() AS calls
        FROM api_usage WHERE project_id = {projectId:UUID}
        GROUP BY provider_id, model ORDER BY cost_usd DESC, provider_id ASC`,
      query_params: params, format: 'JSONEachRow',
    }).then((r) => r.json<Record<string, unknown>>()),

    ch.query({
      query: `SELECT task_id, sum(cost_usd) AS cost_usd, count() AS calls
        FROM api_usage WHERE project_id = {projectId:UUID}
        GROUP BY task_id ORDER BY cost_usd DESC LIMIT {topTaskLimit:UInt8}`,
      query_params: params, format: 'JSONEachRow',
    }).then((r) => r.json<Record<string, unknown>>()),
  ]);

  const totalsRow = totalsRows[0] ?? {};
  return {
    projectId,
    totals: {
      costUsd: num(totalsRow['cost_usd']),
      promptTokens: num(totalsRow['prompt_tokens']),
      completionTokens: num(totalsRow['completion_tokens']),
      calls: num(totalsRow['calls']),
      errors: num(totalsRow['errors']),
    },
    daily: dailyRows.map((row) => ({
      day: String(row['day'] ?? ''),
      costUsd: num(row['cost_usd']),
      calls: num(row['calls']),
    })),
    byModel: modelRows.map((row) => ({
      providerId: String(row['provider_id'] ?? ''),
      model: String(row['model'] ?? ''),
      costUsd: num(row['cost_usd']),
      calls: num(row['calls']),
    })),
    topTasks: taskRows.map((row) => ({
      taskId: String(row['task_id'] ?? ''),
      costUsd: num(row['cost_usd']),
      calls: num(row['calls']),
    })),
  };
}
