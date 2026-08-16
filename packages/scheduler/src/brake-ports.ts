// Güvenlik frenlerinin gerçek veri kaynakları (docs/07 → Frenler).
// brake-guard.ts mekanizmayı kuruyordu; bu modül onu ClickHouse'a bağlar.
import type { ClickHouseClient } from '@ww/db';
import type {
  BrakeGuardPorts,
  ProjectSpendSnapshot,
  TaskBudgetSnapshot,
} from './brake-guard.js';

/** docs/07: görev duvar-saati tavanı (settings.task_wall_clock_min varsayılanı 60 dk). */
export const DEFAULT_WALL_CLOCK_LIMIT_MS = 60 * 60_000;

// ClickHouse DateTime64(3,'UTC') değeri zaman dilimi işareti olmadan döner;
// 'Z' eklenmezse Date.parse onu YEREL saat sanar (bizde 3 saat sapma).
export function parseUtc(value: unknown): number {
  const text = String(value ?? '').trim();
  if (text.length === 0) return Number.NaN;
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/.test(text) ? text : `${text.replace(' ', 'T')}Z`;
  return Date.parse(normalized);
}

const num = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

export interface ClickHouseBrakePortOptions {
  wallClockLimitMs?: number;
  onError?: ((taskId: string, reason: unknown) => void) | undefined;
  nowMs?: () => number;
}

export function createClickHouseBrakePorts(
  ch: ClickHouseClient,
  options: ClickHouseBrakePortOptions = {},
): BrakeGuardPorts {
  async function readTaskBudget(taskId: string): Promise<TaskBudgetSnapshot> {
    const result = await ch.query({
      query: `SELECT token_budget, tokens_spent, created_at
        FROM tasks WHERE task_id = {taskId:UUID}
        ORDER BY version DESC LIMIT 1`,
      query_params: { taskId },
      format: 'JSONEachRow',
    });
    const row = (await result.json<Record<string, unknown>>())[0];
    // Bilinmeyen görev: tavan 0 = sınırsız, fren atmaz.
    if (!row) return { tokensSpent: 0, tokenBudget: 0, startedAtMs: Date.now() };
    return {
      tokensSpent: num(row['tokens_spent']),
      tokenBudget: num(row['token_budget']),
      startedAtMs: parseUtc(row['created_at']) || Date.now(),
    };
  }

  async function readProjectSpend(taskId: string): Promise<ProjectSpendSnapshot> {
    const result = await ch.query({
      // Görevin projesi -> o projenin toplam harcaması ve bütçe limiti.
      query: `WITH task_project AS (
          SELECT project_id FROM tasks WHERE task_id = {taskId:UUID}
          ORDER BY version DESC LIMIT 1
        )
        SELECT
          (SELECT sum(cost_usd) FROM api_usage
             WHERE project_id = (SELECT project_id FROM task_project)) AS spent_usd,
          (SELECT budget_usd_limit FROM projects
             WHERE project_id = (SELECT project_id FROM task_project)
             ORDER BY version DESC LIMIT 1) AS limit_usd`,
      query_params: { taskId },
      format: 'JSONEachRow',
    });
    const row = (await result.json<Record<string, unknown>>())[0];
    if (!row) return { spentUsd: 0, limitUsd: 0 };
    return { spentUsd: num(row['spent_usd']), limitUsd: num(row['limit_usd']) };
  }

  async function readRecentFailures(taskId: string): Promise<readonly string[]> {
    // ÖNEMLİ: tasks ReplacingMergeTree'dir; birleştirme eski sürümleri siler,
    // dolayısıyla ret geçmişi oradan güvenilir okunamaz. events append-only'dir
    // ve geçişleri kalıcı tutar; kaçak döngü sinyali buradan gelmelidir.
    const result = await ch.query({
      query: `SELECT
          JSONExtractString(payload, 'reason') AS reason,
          JSONExtractString(payload, 'action') AS action
        FROM events
        WHERE task_id = {taskId:UUID} AND event_type IN ('status_change', 'error')
        ORDER BY created_at DESC, seq DESC
        LIMIT 20`,
      query_params: { taskId },
      format: 'JSONEachRow',
    });
    const rows = await result.json<Record<string, unknown>>();
    return rows
      .filter((row) => {
        const action = String(row['action'] ?? '');
        return action === '' || action === 'verifier_rejected' || action === 'gate_failed';
      })
      .map((row) => String(row['reason'] ?? ''))
      .filter((reason) => reason.length > 0)
      .slice(0, 3);
  }

  return {
    readTaskBudget,
    readProjectSpend,
    readRecentFailures,
    nowMs: options.nowMs ?? (() => Date.now()),
    wallClockLimitMs: options.wallClockLimitMs ?? DEFAULT_WALL_CLOCK_LIMIT_MS,
    onError: options.onError,
  };
}
