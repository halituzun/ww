// Sohbetten verilen emrin işe dönüşmesi (docs/08 → "çalışan işe emir yollama";
// docs/11 Faz 6 → "sohbetten verilen emrin sonucu önizlemede görülür").
//
// NEDEN VAR: `user_command` mesajı kaydediliyor ve PM'in gelen kutusuna
// düşüyordu ama HİÇBİR ŞEY onu işe çevirmiyordu. Canlı koşuda emir gönderildi,
// mesaj yazıldı, görev sayısı değişmedi: dokümante akış ilk adımında kopuktu.
//
// Hedef dosya adı geçmeyen emir REDDEDİLİR. Sebep bugün pahalıya öğrenildi:
// executor mühürlü hedef dışına yazdırmaz, yani hedefsiz görev hiçbir şey
// üretemez ama kullanıcıya "iş açıldı" der. Sessizce imkânsız bir görev
// açmaktansa ne istendiğini sormak dürüsttür.

export class CommandTaskError extends Error {}

/** Emir metninde geçen dosya yolları: `src/a.ts`, `index.html` gibi. */
const FILE_TOKEN = /(?:[\w.-]+\/)*[\w-]+\.[A-Za-z0-9]{1,6}\b/g;

export interface CommandTaskSpec {
  readonly title: string;
  readonly description: string;
  readonly targetFiles: readonly string[];
  readonly acceptanceCriteria: readonly string[];
}

export function filesInCommand(text: string): readonly string[] {
  return Object.freeze([...new Set(text.match(FILE_TOKEN) ?? [])]);
}

/**
 * Başlık emirden türer. Cümle sonu, NOKTADAN DEĞİL "nokta + boşluk"tan
 * ayrılır: aksi halde "index.html" dosya adı cümle sanılıp "index" olarak
 * kesiliyordu.
 */
function titleOf(text: string): string {
  const firstSentence = text.split(/[.!?](?=\s|$)|\n/)[0]?.trim() ?? '';
  const compact = firstSentence.length > 0 ? firstSentence : text.trim();
  return compact.length <= 80 ? compact : `${compact.slice(0, 77)}…`;
}

/**
 * Dosya adı geçmeyen emir için `null` döner: bu bir HATA DEĞİLDİR. docs/08 PM
 * ile sohbeti de tanımlar; her mesaj dosya düzenleme emri değildir. Ama
 * sessizce geçmek de olmaz — çağıran kullanıcıya görev AÇILMADIĞINI söyler,
 * yoksa kullanıcı iş başladığını sanıp bekler.
 *
 * Hedefsiz görev açmak ise en kötüsü olurdu: executor mühürlü hedef dışına
 * yazdırmaz, yani görev hiçbir şey üretemez ama "açıldı" görünür.
 */
export const NO_TARGET_NOTE =
  'Emirde hedef dosya adı geçmediği için görev açılmadı; mesaj PM’e iletildi. '
  + 'İş açtırmak için dosyayı adıyla yazın, örn: "src/index.html dosyasına başlık ekle".';

export function buildCommandTask(text: string): CommandTaskSpec | null {
  const command = text.trim();
  if (command === '') throw new CommandTaskError('emir bos olamaz');

  const targetFiles = filesInCommand(command);
  if (targetFiles.length === 0) return null;

  return Object.freeze({
    title: titleOf(command),
    description: [
      command,
      '',
      'Bu görev kullanıcının panelden verdiği emirden üretildi.',
      'Yalnızca hedef dosyaları değiştir, soru sorma, bitince report_result çağır.',
    ].join('\n'),
    targetFiles,
    acceptanceCriteria: Object.freeze(targetFiles.map((file) => `${file} emre uygun güncellendi`)),
  });
}
