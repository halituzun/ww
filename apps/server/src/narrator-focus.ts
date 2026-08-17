// Anlatının SORUYA odaklanması (docs/06 → "nasıl yaptın" akışı; docs/11 Faz 6).
//
// NEDEN VAR: narrator sorulan şeyi yok sayıp projenin SON 200 olayını düz bir
// duvar hâlinde birleştiriyordu. Canlı koşuda tek bir dosya soruldu ve cevap
// "kurtarma turu tamamlandı" cümlesini yedi kez içeren, dosyayla ilgisi
// olmayan bir döküm oldu. Kanıt sayısı çok olmak anlatıyı doğru yapmaz.
//
// Narrator KANIT TABANLIDIR: burada metin uydurulmaz, yalnızca hangi kanıtın
// soruyla ilgili olduğu seçilir ve tekrarlar sıkıştırılır.

export interface EvidenceEntry {
  readonly source: string;
  readonly summary: string;
  readonly createdAt: string;
  /** Olayı üreten görev; konuya göre daraltmada kullanılır. */
  readonly taskId?: string | undefined;
  /** Ham yük: dosya yolu gibi konular yalnızca burada geçebilir. */
  readonly raw?: string | undefined;
}

const FILE_TOKEN = /[\w./-]*\/[\w.-]+\.[A-Za-z0-9]+/g;
const UUID_TOKEN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Sorudan konu çıkarır: dosya yolları ve kimlikler. */
export function subjectsOf(question: string): readonly string[] {
  const tokens = [
    ...(question.match(FILE_TOKEN) ?? []),
    ...(question.match(UUID_TOKEN) ?? []),
  ];
  return Object.freeze([...new Set(tokens.map((token) => token.trim()).filter(Boolean))]);
}

const mentions = (entry: EvidenceEntry, subject: string): boolean =>
  entry.summary.includes(subject) || (entry.raw ?? '').includes(subject);

/**
 * Ardışık aynı cümleleri tek satıra indirir: "x (3 kez)". Tekrar bilgisi
 * SİLİNMEZ, sayıya çevrilir — yoksa gerçekten tekrarlanan bir olay tek
 * seferlikmiş gibi okunur.
 */
export function collapseRepeats(entries: readonly EvidenceEntry[]): readonly EvidenceEntry[] {
  const out: EvidenceEntry[] = [];
  let run = 0;
  for (let index = 0; index <= entries.length; index += 1) {
    const entry = entries[index];
    const previous = entries[index - 1];
    if (previous !== undefined && entry !== undefined && entry.summary === previous.summary) {
      run += 1;
      continue;
    }
    if (previous !== undefined) {
      out.push(run === 0 ? previous : { ...previous, summary: `${previous.summary} (${run + 1} kez)` });
      run = 0;
    }
    if (entry === undefined) break;
    if (previous === undefined) continue;
  }
  // İlk öğe döngüde `previous` olarak işlenir; tek öğeli girdi için ek kontrol.
  if (entries.length === 1) return [entries[0]!];
  return Object.freeze(out);
}

/**
 * Soruda bir konu geçiyorsa yalnızca o konuya değen kanıtlar ve onları üreten
 * GÖREVLERİN kanıtları kalır. Hiçbir şey eşleşmezse tümü döner: boş cevap
 * vermek, "kanıt yok" ile "seçemedim"i karıştırmak olurdu.
 */
export function focusEvidence(
  evidence: readonly EvidenceEntry[],
  question: string,
): readonly EvidenceEntry[] {
  const subjects = subjectsOf(question);
  if (subjects.length === 0) return collapseRepeats(evidence);

  const direct = evidence.filter((entry) => subjects.some((subject) => mentions(entry, subject)));
  if (direct.length === 0) return collapseRepeats(evidence);

  const taskIds = new Set(direct.map((entry) => entry.taskId).filter(
    (taskId): taskId is string => typeof taskId === 'string' && taskId !== '',
  ));
  const scoped = evidence.filter((entry) =>
    direct.includes(entry) || (entry.taskId !== undefined && taskIds.has(entry.taskId)));
  return collapseRepeats(scoped);
}
