// docs/10 Ortak Davranışlar: "Proje duraklatılırsa/arşivlenirse süreçler
// kapatılır."
//
// NEDEN VAR: hiçbir yer proje DURUMUNA bakmıyordu. Duraklatılmış bir projenin
// dev sunucusu çalışmaya devam ediyor, port ve kaynak tutuyor ve panelde
// bayat içerik sunuyordu — proje "durdu" derken önizleme canlı görünüyordu.

/** Süreçleri kapatmayı gerektiren proje durumları. */
const STOP_STATUSES: ReadonlySet<string> = new Set(['paused', 'archived', 'completed']);

export function previewMustStop(projectStatus: string): boolean {
  // BİLİNMEYEN durum kapatma sebebi DEĞİLDİR: bilgisizlikle çalışan bir
  // önizlemeyi kapatmak, kullanıcının gözü önünde işi durdurmaktır.
  //
  // `draft`/`gathering`/`planning` de kapatmaz: proje HENÜZ BAŞLAMAMIŞTIR,
  // durdurulmuş değildir. İkisini karıştırmak yeni projede önizlemeyi
  // kapatırdı.
  return STOP_STATUSES.has(projectStatus);
}
