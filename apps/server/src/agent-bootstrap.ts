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
