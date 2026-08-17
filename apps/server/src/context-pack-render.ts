// Bağlam paketinin prompt metnine dönüştürülmesi (docs/06 → Context Builder).
//
// NEDEN VAR: assembly `loadContextPack: async () => ''` idi — agent'lar SIFIR
// proje bağlamıyla çalışıyordu. docs/06'nın "asla unutmama" vaadi tam olarak
// bu paketle karşılanır: geçmiş kararlar, özetler, dosya fihristleri ve
// ilgili mesajlar modele girer. Boş dize dönmek, hafıza katmanını yazıp
// kullanmamaktır.
export interface RenderableChunk {
  readonly sourceTable: 'knowledge' | 'summaries' | 'file_index' | 'messages';
  readonly sourceId: string;
  readonly text: string;
  readonly label: string;
}

const SECTION_TITLE: Record<RenderableChunk['sourceTable'], string> = {
  knowledge: 'Proje kararları ve kısıtları',
  summaries: 'Önceki iş özetleri',
  file_index: 'Dosya fihristi',
  messages: 'İlgili yazışmalar',
};

const ORDER: readonly RenderableChunk['sourceTable'][] = [
  'knowledge', 'summaries', 'file_index', 'messages',
];

export function renderContextPack(chunks: readonly RenderableChunk[]): string {
  if (chunks.length === 0) return '';
  const lines: string[] = [];
  for (const table of ORDER) {
    const section = chunks.filter((chunk) => chunk.sourceTable === table);
    if (section.length === 0) continue;
    lines.push(`## ${SECTION_TITLE[table]}`);
    for (const chunk of section) {
      // Kaynak etiketi kalır: modelin "bunu nereden biliyorum" izi kopmamalı.
      lines.push(`- [${chunk.label}] ${chunk.text.trim()}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}
