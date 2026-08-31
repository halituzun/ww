// Konsey sonucundan plan kaydı (docs/03 → Konsey, docs/02 → plans).
//
// Konseyin çıktısı bir metin değil, PLAN SÜRÜMÜDÜR: görevler plana bağlanır
// (bkz. task-plan-id.ts) ve "bu karar nasıl alındı" sorusunun cevabı plan →
// council_session_id → messages zinciridir.
//
// Faz D: Konsey çıktısı artık 'org_plan' (departmanlar, liderler, sorumluluk
// dosya desenleri, eşzamanlılık sınırı) ve 5 turluk müzakere dökümünü içerir.
import { NIL_UUID, type EntityId, type OrgPlan } from '@ww/shared';

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
export function deriveOrgPlan(projectName: string, goal: string): OrgPlan {
  const lower = `${projectName} ${goal}`.toLowerCase();
  const isSmall = lower.includes('tetris') || lower.includes('pomodoro') || lower.includes('zamanlayıcı') || lower.includes('sayac') || lower.includes('calculator') || lower.includes('hesap') || lower.includes('makine');

  if (isSmall) {
    return {
      departments: [
        {
          id: 'dept-ui',
          name: 'Kullanıcı Arayüzü & Sunum',
          group: 'design',
          lead_role: 'group_lead',
          members: [
            { role: 'worker', count: 1, model_tier: 'medium' },
            { role: 'verifier', count: 1, model_tier: 'medium' },
          ],
          responsibility_patterns: ['src/views/**', 'src/components/**', 'src/styles/**', 'public/**'],
          rationale: 'Kullanıcı etkileşimleri, tuş kontrolleri ve stil düzenlemeleri',
        },
        {
          id: 'dept-core',
          name: 'Oyun Mantığı & Çekirdek Motor',
          group: 'coding',
          lead_role: 'group_lead',
          members: [
            { role: 'worker', count: 1, model_tier: 'heavy' },
            { role: 'verifier', count: 1, model_tier: 'medium' },
          ],
          responsibility_patterns: ['src/core/**', 'src/logic/**', 'src/engine/**', 'src/state/**'],
          rationale: 'Zamanlama döngüsü, durum yönetimi ve temel kurallar',
        },
      ],
      non_department_roles: [
        { role: 'pm', reports_to: 'user', rationale: 'Genel koordinasyon, kullanıcı iletişimi ve plan onayı' },
        { role: 'interviewer', reports_to: 'pm', rationale: 'Gereksinim analizi ve kullanıcı görüşmesi' },
        { role: 'standards_auditor', reports_to: 'pm', rationale: 'MVVM ve kod kalite denetimi' },
      ],
      concurrency_limit: 2,
      estimated_tokens: 18000,
      estimated_cost_usd: 0.045,
    };
  }

  return {
    departments: [
      {
        id: 'dept-frontend',
        name: 'Arayüz & Kullanıcı Deneyimi',
        group: 'design',
        lead_role: 'group_lead',
        members: [
          { role: 'worker', count: 2, model_tier: 'medium' },
          { role: 'verifier', count: 1, model_tier: 'medium' },
        ],
        responsibility_patterns: ['src/views/**', 'src/components/**', 'src/styles/**', 'public/**'],
        rationale: 'Bileşen hiyerarşisi, responsive düzen ve panel etkileşimleri',
      },
      {
        id: 'dept-backend',
        name: 'Arka Uç & Servis Katmanı',
        group: 'coding',
        lead_role: 'group_lead',
        members: [
          { role: 'worker', count: 2, model_tier: 'heavy' },
          { role: 'verifier', count: 1, model_tier: 'medium' },
        ],
        responsibility_patterns: ['src/services/**', 'src/api/**', 'src/controllers/**'],
        rationale: 'İş mantığı, REST uçları ve servis protokolleri',
      },
      {
        id: 'dept-db',
        name: 'Veritabanı & Kalıcılık',
        group: 'db',
        lead_role: 'group_lead',
        members: [
          { role: 'worker', count: 1, model_tier: 'heavy' },
          { role: 'verifier', count: 1, model_tier: 'medium' },
        ],
        responsibility_patterns: ['src/db/**', 'src/schema/**', 'migrations/**'],
        rationale: 'Şema yönetimi, indeksler ve veri bütünlüğü',
      },
      {
        id: 'dept-qa',
        name: 'Kalite Güvence & E2E Test',
        group: 'ui_audit',
        lead_role: 'group_lead',
        members: [
          { role: 'worker', count: 1, model_tier: 'medium' },
          { role: 'verifier', count: 1, model_tier: 'medium' },
        ],
        responsibility_patterns: ['tests/**', 'src/**/*.test.ts', 'src/**/*.spec.ts'],
        rationale: 'Regresyon testleri, uçtan uca senaryolar ve standart denetimi',
      },
    ],
    non_department_roles: [
      { role: 'pm', reports_to: 'user', rationale: 'Proje yönetimi ve kaynak tahsisi' },
      { role: 'interviewer', reports_to: 'pm', rationale: 'Gereksinim mühendisliği' },
      { role: 'narrator', reports_to: 'pm', rationale: 'Olay izleme ve süreç anlatımı' },
      { role: 'standards_auditor', reports_to: 'pm', rationale: 'Mimari standart denetimi' },
    ],
    concurrency_limit: 3,
    estimated_tokens: 45000,
    estimated_cost_usd: 0.12,
  };
}

export function buildCouncilPlan(input: CouncilPlanInput) {
  const effectiveOrgPlan = input.orgPlan ?? deriveOrgPlan(input.projectName, input.goal);
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
    scenarios_json: { scenarios: [] },
    replan_reason: '',
    supersedes_plan_id: input.supersedesPlanId ?? NIL_UUID,
    created_by_agent_id: input.chairAgentId,
    approved_by: '',
    created_at: input.createdAt,
  };
}
