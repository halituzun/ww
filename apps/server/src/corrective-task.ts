// Standart düzeltme görevinin tanımı ve kapsamı.
//
// NEDEN AYRI: ilk canlı düzeltme koşusunda worker haklı olarak takıldı ve
// şunu sordu: "docs/09 mühürlü hedeflerimde değil, okuyamıyorum; MVVM
// düzenini bana söyler misiniz?" — Görev, worker'ın ERİŞEMEYECEĞİ bir
// dokümana atıf yapıyordu. Ayrıca hedef dosyalar yalnızca ihlalli View'ı
// içeriyordu, oysa mantığı taşımak İKİNCİ bir dosya (ViewModel) yazmayı
// gerektirir; worker düzeltmeyi fiilen yapamazdı.
//
// Kural: görev kendi kendine yeterli olmalıdır. Standart metni tanımın
// İÇİNE yazılır, ViewModel yolu hedeflere eklenir.

/** `src/components/Counter.tsx` → `src/viewmodels/useCounter.ts` */
export function viewModelPathFor(viewPath: string): string {
  const parts = viewPath.split('/');
  const file = parts[parts.length - 1] ?? viewPath;
  const base = file.replace(/\.(tsx|jsx)$/, '');
  const root = parts.slice(0, -2).join('/');
  const prefix = root === '' ? '' : `${root}/`;
  return `${prefix}viewmodels/use${base.charAt(0).toUpperCase()}${base.slice(1)}.ts`;
}

const MVVM_RULE = [
  'MVVM düzeni (bu projede geçerli standart):',
  '- View (.tsx): yalnızca çizer. fetch, useState, useEffect KULLANAMAZ.',
  '- ViewModel (src/viewmodels/useXxx.ts): durumu ve yan etkileri tutar,',
  '  React hook’u olarak yazılır ve View’ın ihtiyaç duyduğu değerleri döner.',
  '- View, ViewModel’i çağırır ve dönen değerleri çizer.',
].join('\n');

export function correctiveTaskDescription(input: Readonly<{
  summary: string;
  viewPath: string;
  viewModelPath: string;
  evidenceRefs: readonly string[];
}>): string {
  return [
    input.summary,
    '',
    `Kanıt: ${input.evidenceRefs.join(', ')}`,
    '',
    MVVM_RULE,
    '',
    `Yapılacak: ${input.viewModelPath} dosyasını oluştur ve durumu oraya taşı;`,
    `${input.viewPath} yalnızca onu çağırıp çizsin. Davranışı değiştirme.`,
    'Başka dosya okuma; ihtiyacın olan her şey bu tanımda yazılı.',
  ].join('\n');
}

/** Düzeltme görevinin yazabileceği dosyalar: View + onun ViewModel'i. */
export function correctiveTargetFiles(viewPath: string): readonly string[] {
  return Object.freeze([viewPath, viewModelPathFor(viewPath)]);
}

/**
 * Düzeltme görevinin hedef dosyaları, KURALA göre.
 *
 * NEDEN VAR: metin ve hedefler tamamen STD-001'e (View → ViewModel) göre
 * yazılmıştı. Katman kurallarını (STD-002/003) körlemesine aynı yoldan
 * geçirmek "src/viewmodels/useUseThing.ts oluştur" gibi SAÇMA bir görev
 * üretirdi; worker onu ya yapamaz ya da yanlış dosya yaratır.
 */
export function correctiveTargetFilesFor(
  ruleId: 'STD-001' | 'STD-002' | 'STD-003',
  filePath: string,
): readonly string[] {
  // Katman ihlallerinde düzeltilecek dosya ihlalin KENDİSİDİR; ikinci bir
  // dosya yaratmak gerekmez.
  if (ruleId !== 'STD-001') return Object.freeze([filePath]);
  return correctiveTargetFiles(filePath);
}

const LAYER_RULE: Record<'STD-002' | 'STD-003', readonly string[]> = {
  'STD-002': [
    'Kural: ViewModel katmanı DOM’a dokunmaz.',
    '- document/querySelector/getElementById/innerHTML kullanımı View’a aittir.',
    '- ViewModel yalnızca durumu ve yan etkileri tutar, değer döner.',
  ],
  'STD-003': [
    'Kural: Servis katmanı UI framework’ünden bağımsızdır.',
    '- Servis dosyası React (veya react-dom) import ETMEZ.',
    '- React’a ihtiyaç duyan mantık ViewModel katmanına aittir.',
  ],
};

/** Kurala uygun, KENDİ KENDİNE YETERLİ düzeltme görevi tanımı. */
export function correctiveDescriptionFor(input: Readonly<{
  ruleId: 'STD-001' | 'STD-002' | 'STD-003';
  summary: string;
  filePath: string;
  evidenceRefs: readonly string[];
}>): string {
  if (input.ruleId === 'STD-001') {
    return correctiveTaskDescription({
      summary: input.summary,
      viewPath: input.filePath,
      viewModelPath: viewModelPathFor(input.filePath),
      evidenceRefs: input.evidenceRefs,
    });
  }
  return [
    input.summary,
    '',
    `Kanıt: ${input.evidenceRefs.join(', ')}`,
    '',
    ...LAYER_RULE[input.ruleId],
    '',
    `Yapılacak: ${input.filePath} dosyasını bu kurala uydur. Davranışı değiştirme.`,
    'Başka dosya okuma; ihtiyacın olan her şey bu tanımda yazılı.',
  ].join('\n');
}
