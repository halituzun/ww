// Konseyin organizasyon planından agent kadrosu.
//
// NEDEN VAR: `buildAgentsFromOrgPlan` konseyin departmanlarından kadro
// üretiyordu ama HİÇBİR üretim yolu onu çağırmıyordu. Her proje sabit beş
// agent'la açılıyor, konseyin departmanları ve `group_lead`'leri hiç
// doğmuyordu — buna karşılık panel "Bu plan ve organizasyon onaylandı, agent
// kadrosu kuruldu." diyordu. Bu ayrıca docs/13'ün `group_lead` ve
// `professor` tırmandırma basamaklarını ERİŞİLEMEZ kılıyordu: politika kodda
// vardı, o rolde agent hiç yaratılmıyordu.
//
// Bağlanamamasının ikinci sebebi de buydu: ürettiği rollerin kanonik
// promptları yoktu ve prompt planlayıcı ilk denemede "kanonik prompt
// bulunamadı" ile patlardı. 0010 migration'ı o boşluğu kapattı.

import type { OrgPlan } from '@ww/shared';
import { buildAgentsFromOrgPlan, type CanonicalPrompt, type DynamicAgentSpec } from './agent-bootstrap.js';

/**
 * Kadro promptları bootstrap promptlarından AYRI adlandırılır.
 *
 * NEDEN kanonik prompt adına göre: `bootstrap.<pid>.<rol>` şeması worker'ları
 * role göre adlandırır, ama org planında `design` ve `coding` worker'ları
 * aynı role sahiptir. Aynı ada iki farklı içerik yazmak, tasarım worker'ına
 * kodlama prompt'u vermek demekti.
 */
export function rosterPromptName(projectId: string, canonicalPrompt: string): string {
  return `roster.${projectId}.${canonicalPrompt}`;
}

export interface RosterPromptRow {
  readonly prompt_name: string;
  readonly prompt_version: number;
  readonly content: string;
  readonly variables: readonly string[];
  readonly changelog: string;
  readonly is_active: boolean;
}

export interface RosterAgentSpec {
  readonly role: string;
  readonly group: string;
  readonly name: string;
  readonly model: string;
  readonly promptName: string;
}

export interface OrgRosterPlan {
  readonly prompts: readonly RosterPromptRow[];
  readonly agents: readonly RosterAgentSpec[];
  /** Kanonik promptu bulunamadığı için kurulamayan roller. */
  readonly missingPrompts: readonly string[];
}

export interface PlanOrgRosterInput {
  readonly projectId: string;
  readonly orgPlan: OrgPlan;
  /** Zaten var olan agent adları; kadro kurulumu İDEMPOTENTTİR. */
  readonly existingAgentNames: ReadonlySet<string>;
  readonly canonical: ReadonlyMap<string, CanonicalPrompt>;
}

/**
 * Kadro planı. Saf fonksiyon: yazma yapmaz, yalnız ne yazılacağını söyler.
 *
 * Eksik kanonik prompt SESSİZCE atlanmaz — `missingPrompts` ile geri döner ve
 * çağıran taraf bunu görünür kılar. Sessiz atlama, "kadro kuruldu" diyip
 * yarım kadro kurmak olurdu.
 */
export function planOrgRoster(input: PlanOrgRosterInput): OrgRosterPlan {
  const specs = buildAgentsFromOrgPlan(input.orgPlan);

  const prompts = new Map<string, RosterPromptRow>();
  const agents: RosterAgentSpec[] = [];
  const missing = new Set<string>();

  for (const spec of specs) {
    if (input.existingAgentNames.has(spec.name)) continue;

    const source = input.canonical.get(spec.canonicalPrompt);
    if (source === undefined) {
      missing.add(spec.canonicalPrompt);
      continue;
    }

    const promptName = rosterPromptName(input.projectId, spec.canonicalPrompt);
    if (!prompts.has(promptName)) {
      prompts.set(promptName, {
        prompt_name: promptName,
        prompt_version: 1,
        content: source.content,
        variables: [],
        changelog: `${spec.canonicalPrompt} v${source.prompt_version} kopyalandı (org planı kadrosu)`,
        is_active: true,
      });
    }

    agents.push({
      role: spec.role,
      group: spec.group,
      name: spec.name,
      model: spec.model,
      promptName,
    });
  }

  return Object.freeze({
    prompts: Object.freeze([...prompts.values()]),
    agents: Object.freeze(agents),
    missingPrompts: Object.freeze([...missing]),
  });
}

/** Kadronun ihtiyaç duyduğu kanonik prompt adları (okuma listesi). */
export function rosterCanonicalPromptNames(orgPlan: OrgPlan): readonly string[] {
  return Object.freeze([
    ...new Set(buildAgentsFromOrgPlan(orgPlan).map((spec: DynamicAgentSpec) => spec.canonicalPrompt)),
  ]);
}
