// docs/06 Hafıza Piramidi, özet katmanı: "her görev bitiminde özetleyici agent
// görev özetini yazar".
//
// NEDEN VAR: `summaries` tablosu CANLI VERİTABANINDA TAMAMEN BOŞTU (8
// tamamlanmış göreve rağmen 0 satır). Yazıcı (`MemoryService.appendSummary`)
// yazılmıştı ama HİÇBİR ÇAĞIRANI yoktu — piramidin orta katmanı hiç
// oluşmuyordu. Context Builder onu her seferinde sorguluyor ve boş dönüyordu:
// yani "asla unutmama" çekirdeği fiilen unutuyordu.
//
// BİLİNÇLİ SAPMA: docs/06 özeti bir MODELİN yazmasını tarif ediyor. Bu sürüm
// özeti görev kaydından DETERMİNİSTİK üretir. Gerekçe: model çağrısı paralıdır
// ve her görev bitiminde bir çağrı daha eklemek maliyeti sessizce artırır;
// ayrıca elimizdeki veri (başlık, sonuç, commit, dosyalar, deneme sayısı)
// zaten sonraki agent'ın ihtiyaç duyduğu bağlamdır. Boş bir orta katman,
// deterministik bir orta katmandan her durumda kötüdür.

export interface TaskSummaryInput {
  readonly title: string;
  readonly resultSummary: string;
  readonly commitHash: string;
  readonly targetFiles: readonly string[];
  /** Kaçıncı denemede bittiği: "bu iş zordu" bilgisini taşır. */
  readonly attempts: number;
}

const SHORT_HASH_LENGTH = 7;

export function buildTaskSummary(input: TaskSummaryInput): string {
  const result = input.resultSummary.trim();
  const commit = input.commitHash.trim().slice(0, SHORT_HASH_LENGTH);
  const attempt = Number.isSafeInteger(input.attempts) && input.attempts > 1
    ? `${input.attempts}. denemede`
    : 'ilk denemede';

  return [
    `Görev: ${input.title}`,
    // Olmayan bir sonucu varmış gibi yazmak hafızayı yanlış bilgiyle doldurur.
    `Sonuç: ${result === '' ? '(worker sonuç özeti bırakmadı)' : result}`,
    `Tamamlandı: ${attempt}${commit === '' ? '' : `, commit ${commit}`}`,
    `Dokunulan dosyalar: ${input.targetFiles.length === 0
      ? '(dosya bildirilmedi)'
      : input.targetFiles.join(', ')}`,
  ].join('\n');
}
