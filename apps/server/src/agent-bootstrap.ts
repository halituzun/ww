// Panelden açılan projenin başlangıç agent kadrosu ve promptları.
//
// NEDEN VAR: bootstrap, `bootstrap.<projectId>.<rol>` adlı promptlara işaret
// eden agent'lar yaratıyordu ama O PROMPT SATIRLARINI HİÇ OLUŞTURMUYORDU.
// Sarkan referans, brief mühürlemede 'as-of prompt bulunamadi' ile patlıyor
// ve projenin HİÇBİR görevi koşamıyordu. Prompt içeriği kanonik rol
// promptundan kopyalanır: böylece proje bazında düzenlenebilir kalır
// (docs/03) ama boş/yok bir şablonla model çalıştırılmaz.

export interface BootstrapAgentSpec {
  readonly role: 'pm' | 'worker' | 'verifier';
  readonly group: 'management' | 'coding';
  readonly name: string;
  readonly model: string;
  /** İçeriğin kopyalanacağı kanonik rol promptu. */
  readonly canonicalPrompt: string;
}

/**
 * Kadro İKİŞER worker/verifier içerir. Sebep: verifier reddettiğinde yeniden
 * atama FARKLI bir worker ister (aynı agent aynı hatayı tekrarlamasın diye);
 * tek worker'lı projede retry "idle worker bulunamadi" ile kilitleniyordu —
 * yani ilk ret görevi kalıcı olarak durduruyordu.
 */
export const BOOTSTRAP_AGENTS: readonly BootstrapAgentSpec[] = [
  { role: 'pm', group: 'management', name: 'PM', model: 'mock:pm', canonicalPrompt: 'role.pm' },
  { role: 'worker', group: 'coding', name: 'Worker 1', model: 'mock:worker', canonicalPrompt: 'role.worker.coding' },
  { role: 'worker', group: 'coding', name: 'Worker 2', model: 'mock:worker', canonicalPrompt: 'role.worker.coding' },
  { role: 'verifier', group: 'coding', name: 'Verifier 1', model: 'mock:verifier', canonicalPrompt: 'role.verifier' },
  { role: 'verifier', group: 'coding', name: 'Verifier 2', model: 'mock:verifier', canonicalPrompt: 'role.verifier' },
];

export function bootstrapPromptName(projectId: string, role: string): string {
  return `bootstrap.${projectId}.${role}`;
}

export interface CanonicalPrompt {
  readonly prompt_name: string;
  readonly prompt_version: number;
  readonly content: string;
}

export interface BootstrapPromptRow {
  readonly prompt_name: string;
  readonly prompt_version: number;
  readonly content: string;
  readonly variables: readonly string[];
  readonly changelog: string;
  readonly is_active: boolean;
}

export function planBootstrapPrompts(
  projectId: string,
  canonical: ReadonlyMap<string, CanonicalPrompt>,
): readonly BootstrapPromptRow[] {
  // Aynı rolden birden çok agent AYNI promptu paylaşır; her agent için satır
  // üretmek mükerrer prompt yazımı olurdu.
  const seen = new Set<string>();
  return BOOTSTRAP_AGENTS.filter((agent) => {
    const name = bootstrapPromptName(projectId, agent.role);
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  }).map((agent) => {
    const source = canonical.get(agent.canonicalPrompt);
    // Boş içerikli prompt üretmek, modeli talimatsız çalıştırmaktır.
    if (source === undefined) {
      throw new Error(`kanonik prompt bulunamadı: ${agent.canonicalPrompt}`);
    }
    return {
      prompt_name: bootstrapPromptName(projectId, agent.role),
      // Agent satırı prompt_version=1 taşır; uyuşmazsa yine sarkan referans olur.
      prompt_version: 1,
      content: source.content,
      variables: [],
      changelog: `${agent.canonicalPrompt} v${source.prompt_version} kopyalandı`,
      is_active: true,
    };
  });
}

import type { OrgPlan } from '@ww/shared';

export interface DynamicAgentSpec {
  readonly role: string;
  readonly group: string;
  readonly name: string;
  readonly model: string;
  readonly canonicalPrompt: string;
}

export function buildAgentsFromOrgPlan(orgPlan: OrgPlan): readonly DynamicAgentSpec[] {
  const specs: DynamicAgentSpec[] = [];

  // 1. Departman dışı roller
  for (const nonDept of orgPlan.non_department_roles) {
    if (nonDept.role === 'pm') {
      specs.push({ role: 'pm', group: 'management', name: 'PM', model: 'mock:pm', canonicalPrompt: 'role.pm' });
    } else if (nonDept.role === 'interviewer') {
      specs.push({ role: 'interviewer', group: 'analysis', name: 'Görüşmeci', model: 'mock:interviewer', canonicalPrompt: 'role.interviewer' });
    } else if (nonDept.role === 'standards_auditor') {
      specs.push({ role: 'standards_auditor', group: 'ui_audit', name: 'Standart Denetçisi', model: 'mock:auditor', canonicalPrompt: 'role.standards_auditor' });
    } else if (nonDept.role === 'narrator') {
      specs.push({ role: 'narrator', group: 'management', name: 'Anlatıcı', model: 'mock:narrator', canonicalPrompt: 'role.narrator' });
    }
  }

  // 2. Departmanlar ve üyeleri
  for (const dept of orgPlan.departments) {
    // Departman lideri
    specs.push({
      role: dept.lead_role || 'group_lead',
      group: dept.group,
      name: `${dept.name} Lideri`,
      model: 'mock:group_lead',
      canonicalPrompt: 'role.group_lead',
    });

    // Departman üyeleri (worker ve verifier)
    for (const member of dept.members) {
      for (let i = 1; i <= member.count; i++) {
        const title = member.role === 'verifier' ? 'Denetleyen' : 'Yapan';
        specs.push({
          role: member.role,
          group: dept.group,
          name: `${dept.name} ${title} ${i}`,
          model: `mock:${member.role}`,
          canonicalPrompt: member.role === 'verifier' ? 'role.verifier' : `role.worker.${dept.group}`,
        });
      }
    }
  }

  return Object.freeze(specs);
}
