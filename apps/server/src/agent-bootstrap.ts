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

export const BOOTSTRAP_AGENTS: readonly BootstrapAgentSpec[] = [
  { role: 'pm', group: 'management', name: 'PM', model: 'mock:pm', canonicalPrompt: 'role.pm' },
  { role: 'worker', group: 'coding', name: 'Worker', model: 'mock:worker', canonicalPrompt: 'role.worker.coding' },
  { role: 'verifier', group: 'coding', name: 'Verifier', model: 'mock:verifier', canonicalPrompt: 'role.verifier' },
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
  return BOOTSTRAP_AGENTS.map((agent) => {
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
