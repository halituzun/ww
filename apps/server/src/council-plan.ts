// Konsey sonucundan plan kaydı (docs/03 → Konsey, docs/02 → plans).
//
// Konseyin çıktısı bir metin değil, PLAN SÜRÜMÜDÜR: görevler plana bağlanır
// (bkz. task-plan-id.ts) ve "bu karar nasıl alındı" sorusunun cevabı plan →
// council_session_id → messages zinciridir. Bu zincir kurulmazsa konsey
// koşulmuş ama hiçbir şeyi etkilememiş olur.
//
// Plan 'proposed' olarak yazılır: docs/11 kullanıcı onayını şart koşar.
// Otomatik 'approved' yazmak, olmayan bir onayı varmış gibi göstermek olurdu.
import { NIL_UUID, type EntityId } from '@ww/shared';

export interface CouncilTurnLike {
  readonly memberId: string;
  readonly kind: string;
  readonly text: string;
}

export interface CouncilPlanInput {
  readonly projectId: EntityId;
  readonly projectName: string;
  readonly planId: EntityId;
  readonly planVersion: number;
  readonly sessionId: EntityId;
  readonly chairAgentId: EntityId;
  readonly goal: string;
  readonly proposals: readonly CouncilTurnLike[];
  readonly objections: readonly CouncilTurnLike[];
  readonly synthesis: CouncilTurnLike;
  readonly memberModelRefs: readonly string[];
  /** Çeşitlilik hedefin altındaysa plana AÇIKÇA yazılır. */
  readonly diversityWarning: string;
  readonly supersedesPlanId?: EntityId;
  readonly createdAt: string;
}

const section = (title: string, turns: readonly CouncilTurnLike[]): string => [
  `## ${title}`,
  '',
  ...turns.flatMap((turn) => [`- **${turn.memberId.slice(0, 8)}**: ${turn.text.trim()}`, '']),
].join('\n');

export function buildCouncilPlan(input: CouncilPlanInput) {
  const body = [
    `# ${input.projectName} — konsey planı`,
    '',
    `**Hedef:** ${input.goal.trim()}`,
    '',
    `**Konsey üyeleri:** ${input.memberModelRefs.join(', ')}`,
    ...(input.diversityWarning === '' ? [] : ['', `> ⚠️ ${input.diversityWarning}`]),
    '',
    '## Sentez (karar)',
    '',
    input.synthesis.text.trim(),
    '',
    section('Öneriler', input.proposals),
    section('İtirazlar', input.objections),
  ].join('\n');

  return {
    plan_id: input.planId,
    project_id: input.projectId,
    plan_version: input.planVersion,
    // Kullanıcı onayı beklenir; otomatik onaylamak olmayan bir onayı
    // varmış gibi göstermek olurdu (docs/11 Faz 4).
    status: 'proposed' as const,
    title: `${input.projectName} — konsey planı v${input.planVersion}`,
    content_md: body,
    council_session_id: input.sessionId,
    team_json: { members: [...input.memberModelRefs] },
    scenarios_json: { scenarios: [] },
    replan_reason: '',
    supersedes_plan_id: input.supersedesPlanId ?? NIL_UUID,
    created_by_agent_id: input.chairAgentId,
    approved_by: '',
    created_at: input.createdAt,
  };
}
