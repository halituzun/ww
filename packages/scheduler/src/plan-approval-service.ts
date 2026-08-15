import { appendPlanVersion, listLatestPlansByStatus, type ClickHouseClient, type PlanRow } from '@ww/db';
import { type EntityId } from '@ww/shared';

export class PlanApprovalError extends Error { constructor(message: string) { super(message); this.name = 'PlanApprovalError'; } }
export interface PlanApprovalInput { readonly projectId: EntityId; readonly planId: EntityId; readonly approved: boolean; readonly actor: string; readonly now: string; readonly note?: string; }

export class PlanApprovalService {
  readonly #ch: ClickHouseClient;
  constructor(ch: ClickHouseClient) { this.#ch = ch; }
  async apply(input: PlanApprovalInput): Promise<PlanRow> {
    const candidates = await Promise.all((['debating', 'proposed', 'approved', 'rejected'] as const).map((status) => listLatestPlansByStatus(this.#ch, input.projectId, status)));
    const plan = candidates.flat().find((row) => row.plan_id === input.planId);
    if (plan === undefined) throw new PlanApprovalError('plan bulunamadi');
    if (plan.status !== 'debating' && plan.status !== 'proposed') {
      if ((input.approved && plan.status === 'approved') || (!input.approved && plan.status === 'rejected')) return plan;
      throw new PlanApprovalError('plan bu durumda onaylanamaz');
    }
    const next: Omit<PlanRow, 'version' | 'observed_at'> = {
      ...plan,
      status: input.approved ? 'approved' : 'rejected',
      approved_by: input.approved ? input.actor : '',
      replan_reason: input.note ?? plan.replan_reason,
    };
    return appendPlanVersion(this.#ch, { expectedVersion: plan.version, next });
  }
}
