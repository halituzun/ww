// Plan oluşturma yolu.
//
// NEDEN VAR: `createPlan` @ww/db içinde yazılıydı ama HİÇBİR üretim kodundan
// çağrılmıyordu — yani üründen plan yaratmanın yolu yoktu. Görev ise plana
// ait olmak zorunda ('task plan kimligi tasimiyor'), dolayısıyla hiçbir iş
// koşamıyordu. Konsey akışı gelene kadar plan buradan da açılabilir; docs/08
// zaten kullanıcının plana müdahale edebilmesini şart koşuyor.
import { z } from 'zod';
import { NIL_UUID, PLAN_STATUSES, type EntityId } from '@ww/shared';

const PlanInput = z.strictObject({
  title: z.string().trim().min(1),
  contentMd: z.string().trim().min(1),
  status: z.enum(PLAN_STATUSES).default('approved'),
});

export type PlanInputValue = z.infer<typeof PlanInput>;

export const parsePlanInput = (value: unknown): PlanInputValue => PlanInput.parse(value);

export interface PlanRowContext {
  readonly projectId: EntityId;
  readonly planId: EntityId;
  readonly agentId: EntityId;
  readonly now: string;
}

export function buildPlanRow(context: PlanRowContext, input: PlanInputValue) {
  return {
    plan_id: context.planId,
    project_id: context.projectId,
    plan_version: 1,
    status: input.status,
    title: input.title,
    content_md: input.contentMd,
    council_session_id: NIL_UUID,
    team_json: [],
    scenarios_json: [],
    replan_reason: '',
    supersedes_plan_id: NIL_UUID,
    // "Bu kararı kim aldı" izlenebilir kalmalı.
    created_by_agent_id: context.agentId,
    approved_by: '',
    created_at: context.now,
  };
}
