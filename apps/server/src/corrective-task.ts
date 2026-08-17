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
