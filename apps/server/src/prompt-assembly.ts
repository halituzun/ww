// Mühürlü prompt girdisinin mesaj kısmını kurar (docs/03 → prompt şablonları,
// docs/06 → Context Builder).
//
// Görev brifi atama anında mühürlenir ve promptRefs/ruleRefs/goal/
// acceptanceCriteria/targetFiles/allowedTools taşır. Bu modül o mühürlü
// veriden modele gidecek mesajları üretir; hiçbir şeyi yeniden keşfetmez.
import type { TaskBriefV1 } from '@ww/shared';

export interface PromptMessage {
  role: 'system' | 'user';
  content: string;
}

export interface AssembleInput {
  brief: TaskBriefV1;
  /** `prompts` tablosundaki aktif şablon (brief.promptRefs ile sabitlenmiş). */
  template: string;
  /** docs/06 Context Builder çıktısı; hafızadan derlenen bağlam. */
  contextPack: string;
}

const PLACEHOLDER = /\{\{([a-z_]+)\}\}/g;

/**
 * Şablon değişkenlerini doldurur. Eksik değişkeni SESSİZCE geçmez: doldurulmamış
 * yer tutucu modele ham `{{context_pack}}` metni olarak gider ve prompt bozulur.
 */
export function renderPromptTemplate(
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  const missing: string[] = [];
  const rendered = template.replace(PLACEHOLDER, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) {
      missing.push(name);
      return '';
    }
    return value;
  });
  if (missing.length > 0) {
    throw new Error(`prompt şablonunda doldurulmamış değişken: ${[...new Set(missing)].join(', ')}`);
  }
  return rendered;
}

const list = (items: readonly string[], empty: string): string =>
  items.length === 0 ? empty : items.map((item) => `- ${item}`).join('\n');

export function assemblePromptMessages(input: AssembleInput): PromptMessage[] {
  if (input.template.trim().length === 0) throw new Error('prompt şablonu boş olamaz');

  const brief = input.brief as unknown as {
    goal: string;
    acceptanceCriteria: readonly string[];
    targetFiles: readonly string[];
    allowedTools: readonly string[];
    tokenBudget: number;
  };

  const system = renderPromptTemplate(input.template, {
    task_description: brief.goal,
    acceptance_criteria: list(brief.acceptanceCriteria, '(belirtilmedi)'),
    context_pack: input.contextPack.trim() === '' ? '(bağlam yok)' : input.contextPack,
    target_files: list(brief.targetFiles, '(serbest)'),
    project_name: 'ww projesi',
    standards: '(brief ruleRefs ile mühürlendi)',
    diff: '(worker turunda yok)',
    result_summary: '(worker turunda yok)',
    material: input.contextPack,
    target_length: '200 kelime',
    question: brief.goal,
    trail: input.contextPack,
    active_plan: '(brief planVersion ile mühürlendi)',
  });

  // GÖREV, şablondan BAĞIMSIZ olarak iletilir. Şablon değişkenleri yalnızca
  // sistem metnine konur ve bootstrap şablonlarında hiç yer tutucu yoktur:
  // hedef sessizce düşüyordu. Canlı koşuda worker "bana görev verilmemiş"
  // diye soru sordu ve hiçbir iş ilerlemedi. Hedefi burada yazmak, şablon ne
  // olursa olsun görevin ulaşmasını garanti eder.
  const goal = brief.goal.trim();
  const task = [
    `Görev:\n${goal === '' ? '(belirtilmedi)' : goal}`,
    `Kabul kriterleri:\n${list(brief.acceptanceCriteria, '- (belirtilmedi)')}`,
  ].join('\n\n');

  // Kapsam bilgisi ayrı bir user mesajında: worker'ın hedef dosya ve araç
  // sınırını görmesi, sandbox reddine düşmeden doğru davranması için gerekir.
  const scope = [
    `Hedef dosyalar:\n${list(brief.targetFiles, '- (kısıt yok)')}`,
    `İzinli araçlar:\n${list(brief.allowedTools, '- (kısıt yok)')}`,
    `Token bütçesi: ${brief.tokenBudget === 0 ? 'sınırsız' : brief.tokenBudget}`,
  ].join('\n\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: task },
    { role: 'user', content: scope },
  ];
}
