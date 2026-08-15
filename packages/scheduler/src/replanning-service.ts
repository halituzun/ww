import { appendPlanVersion, listLatestPlansByStatus, type ClickHouseClient, type PlanRow } from '@ww/db';
import { type EntityId } from '@ww/shared';

export interface ReplanInput {
  readonly projectId: EntityId;
  readonly reason: string;
  readonly summary: string;
  readonly now: string;
}

export class ReplanningService {
  readonly #ch: ClickHouseClient;
  constructor(ch: ClickHouseClient) { this.#ch = ch; }
  async replan(input: ReplanInput): Promise<PlanRow> {
    const candidates = await Promise.all((['debating', 'proposed', 'approved'] as const).map((status) => listLatestPlansByStatus(this.#ch, input.projectId, status)));
    const current = candidates.flat().sort((a, b) => b.observed_at.localeCompare(a.observed_at))[0] ?? null;
    if (current === null) throw new Error('aktif plan bulunamadi');
    const next: Omit<PlanRow, 'version' | 'observed_at'> = {
      ...current,
      content_md: `${current.content_md}\n\n## Replan\n${input.summary.trim()}`,
      replan_reason: input.reason.trim(),
      created_at: current.created_at,
    };
    return appendPlanVersion(this.#ch, { expectedVersion: current.version, next });
  }
}
