// Konsey sonucundan plan kaydı (docs/03 → Konsey, docs/02 → plans).
//
// Konseyin çıktısı bir metin değil, PLAN SÜRÜMÜDÜR: görevler plana bağlanır
// (bkz. task-plan-id.ts) ve "bu karar nasıl alındı" sorusunun cevabı plan →
// council_session_id → messages zinciridir.
//
// Faz D: Konsey çıktısı artık 'org_plan' (departmanlar, liderler, sorumluluk
// dosya desenleri, eşzamanlılık sınırı) ve 5 turluk müzakere dökümünü içerir.
import { orgPlanFromSynthesis } from './org-plan-parse.js';
import { parsePlanTasksFromMarkdown, type PlanTaskSpecV1, NIL_UUID, type EntityId, type OrgPlan } from '@ww/shared';

export interface CouncilTurnLike {
  readonly memberId: string;
  readonly kind: string;
  readonly turnNumber?: number;
  readonly turnTitle?: string;
  readonly text: string;
  readonly dissenting?: boolean;
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
  readonly draftSynthesis?: CouncilTurnLike;
  readonly redTeam?: CouncilTurnLike;
  readonly finalSynthesis?: CouncilTurnLike;
  readonly synthesis: CouncilTurnLike;
  readonly allTurns?: readonly CouncilTurnLike[];
  readonly convergenceLog?: readonly {
    readonly openObjectionCount?: number;
    readonly unresolvedCount: number;
    readonly contradictionCount: number;
    readonly needsResearch: boolean;
    readonly logLine?: string;
  }[];
  readonly status?: 'converged' | 'uncoordinated';
  readonly memberModelRefs: readonly string[];
  readonly diversityWarning: string;
  /** Konsey oturumundaki FARKLI sağlayıcı sayısı (docs/03 en az 3 ister). */
  readonly distinctProviders?: number | undefined;
  readonly orgPlan?: OrgPlan;
  readonly supersedesPlanId?: EntityId;
  readonly createdAt: string;
}

const speakerLabel = (turn: CouncilTurnLike, index: number): string => {
  if (turn.kind === 'draft_synthesis' || turn.kind === 'final_synthesis') return 'Proje Yöneticisi';
  if (turn.kind === 'red_team' || turn.kind === 'debate_round') return 'Kırmızı Takım Lideri';
  if (turn.kind === 'research') return 'Araştırma Lideri';
  return `Grup Lideri ${index + 1}`;
};

const dynamicTranscript = (turns: readonly CouncilTurnLike[], memberModelRefs: readonly string[]): string => {
  if (turns.length === 0) return '';
  return turns.map((turn) => [
    `## ${turn.turnTitle ?? `Tur ${turn.turnNumber ?? '?'}`}`,
    '',
    `**Konuşmacı:** ${speakerLabel(turn, Math.max(0, (turn.turnNumber ?? 1) - 1))}`,
    `**Model:** ${memberModelRefs[Math.max(0, Math.min(memberModelRefs.length - 1, (turn.turnNumber ?? 1) - 1))] ?? 'bilinmiyor'}`,
    `**Tür:** ${turn.kind}`,
    '',
    turn.text.trim(),
    '',
  ].join('\n')).join('\n');
};

const convergenceTable = (rows: NonNullable<CouncilPlanInput['convergenceLog']>): string => {
  if (rows.length === 0) return '';
  return [
    '## Yakınsama Ölçümü (H1)',
    '',
    '| Tur | Açık itiraz | Çözümsüz bulgu | Çelişki | Araştırma |',
    '|-----|-------------|----------------|---------|-----------|',
    ...rows.map((row) => {
      const turn = /tur=(\d+)/u.exec(row.logLine ?? '')?.[1] ?? '?';
      return `| ${turn} | ${row.openObjectionCount ?? 0} | ${row.unresolvedCount} | ${row.contradictionCount} | ${row.needsResearch ? 'evet' : 'hayır'} |`;
    }),
    '',
  ].join('\n');
};

/**
 * Proje hedefine ve ölçeğine göre deterministik OrgPlan türetir (Ölçek Kuralı - D1).
 * Küçük proje (Tetris, Pomodoro, sayaç) → 2 departman, 4-6 agent.
 * Büyük proje (10+ ekran, tam stack) → 4-5 departman, 8-12 agent.
 */
/**
 * Konsey sentezinden departman okunamadığında kullanılan YEDEK plan.
 *
 * NEDEN kelime listesi kaldırıldı: eski `deriveOrgPlan` proje büyüklüğünü
 * `includes('tetris') || includes('pomodoro') || includes('hesap') ...`
 * ile tahmin ediyor ve konseyin nihai sentezini HİÇ okumuyordu. Model ne
 * derse desin sonuç iki sabit şablondan biriydi; "Zamanlayıcı servisini
 * yeniden yaz" gibi büyük bir backend işi "küçük proje" sayılıp iki
 * departmana indirgeniyordu.
 *
 * Yedek plan artık proje büyüklüğü hakkında BİR ŞEY İDDİA ETMEZ: tek bir
 * kodlama departmanı açar ve planın gövdesine bunun yedek olduğu yazılır.
 */
export function fallbackOrgPlan(): OrgPlan {
  return {
    departments: [
      {
        id: 'dept-core',
        name: 'Uygulama',
        group: 'coding',
        lead_role: 'group_lead',
        members: [
          { role: 'worker', count: 1, model_tier: 'heavy' },
          { role: 'verifier', count: 1, model_tier: 'medium' },
        ],
        responsibility_patterns: ['src/**'],
        rationale: 'Konsey sentezinden departman okunamadı; tek departmanlı yedek yerleşim',
      },
    ],
    non_department_roles: [
      { role: 'pm', reports_to: 'user', rationale: 'Genel koordinasyon ve plan onayı' },
      { role: 'interviewer', reports_to: 'pm', rationale: 'Gereksinim analizi' },
      { role: 'standards_auditor', reports_to: 'pm', rationale: 'MVVM ve kod kalite denetimi' },
    ],
    concurrency_limit: 2,
    // Elimizde gerçek tahmin yok; sıfır "hesaplanmadı" demektir.
    estimated_tokens: 0,
    estimated_cost_usd: 0,
  };
}

export function buildCouncilPlan(input: CouncilPlanInput) {
  const finalTurn = input.finalSynthesis ?? input.synthesis;
  // Ayrıştırma hatası YUTULMAZ ama planın yazılmasını da engellemez: görevsiz
  // plan yazılır, onay ucu bunu açıkça reddeder ve kullanıcı sebebi görür.
  let planTasks: readonly PlanTaskSpecV1[] = [];
  let planTaskError = '';
  try {
    planTasks = parsePlanTasksFromMarkdown(finalTurn.text);
  } catch (reason) {
    planTaskError = reason instanceof Error ? reason.message : String(reason);
  }
  const parsedOrgPlan = input.orgPlan ?? orgPlanFromSynthesis(finalTurn.text);
  const effectiveOrgPlan = parsedOrgPlan ?? fallbackOrgPlan();
  const orgPlanWarning = parsedOrgPlan === undefined
    ? 'Organizasyon planı nihai sentezden okunamadı ("## DEPARTMANLAR" bölümü yok); tek departmanlı yedek yerleşim kullanıldı.'
    : '';
  const allTurns = input.allTurns ?? [
    ...input.proposals,
    ...input.objections,
    ...(input.draftSynthesis ? [input.draftSynthesis] : []),
    ...(input.redTeam ? [input.redTeam] : []),
    input.finalSynthesis ?? input.synthesis,
  ];

  const body = [
    `# ${input.projectName} — konsey planı`,
    '',
    `**Hedef:** ${input.goal.trim()}`,
    '',
    `**Konsey üyeleri:** ${input.memberModelRefs.join(', ')}`,
    `**Durum:** ${input.status ?? 'converged'}`,
    ...(input.diversityWarning === '' ? [] : ['', `> ⚠️ ${input.diversityWarning}`]),
    ...(planTaskError === '' ? [] : ['', `> ⚠️ Görev kırılımı okunamadı: ${planTaskError}`]),
    ...(orgPlanWarning === '' ? [] : ['', `> ⚠️ ${orgPlanWarning}`]),
    '',
    '## Sentez (Nihai Karar & Görevler)',
    '',
    (input.finalSynthesis ?? input.synthesis).text.trim(),
    '',
    convergenceTable(input.convergenceLog ?? []),
    dynamicTranscript(allTurns, input.memberModelRefs),
  ].filter(Boolean).join('\n');

  return {
    plan_id: input.planId,
    project_id: input.projectId,
    plan_version: input.planVersion,
    status: 'proposed' as const,
    title: `${input.projectName} — konsey planı v${input.planVersion}`,
    content_md: body,
    council_session_id: input.sessionId,
    team_json: {
      members: [...input.memberModelRefs],
      org_plan: effectiveOrgPlan,
    },
    // GÖREV GRAFİĞİ. Bu alan eskiden her yerde `{ scenarios: [] }` olarak
    // boş yazılıyor ve hiçbir üretim kodu okumuyordu; plan onayı da hiçbir
    // görev üretmiyordu. Konseyin nihai sentezindeki `## GÖREVLER` bölümü
    // burada makine okunur biçimde saklanır ve onay anında göreve dönüşür.
    scenarios_json: { version: 1, tasks: planTasks },
    replan_reason: '',
    supersedes_plan_id: input.supersedesPlanId ?? NIL_UUID,
    created_by_agent_id: input.chairAgentId,
    approved_by: '',
    // Çapraz kontrolün gerçekliği plana VERİ olarak yazılır; uyarı metni
    // sorgulanamaz ve onay kararında kullanılamazdı.
    provider_diversity: input.distinctProviders ?? 0,
    created_at: input.createdAt,
  };
}
