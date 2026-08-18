// docs/08 WebSocket Olay Sözleşmesi: `cursor: string` — OPAK, proje kapsamlı.
// Doküman ayrıca açıkça şunu söylüyor: "`events.seq` alanı public istemci
// sözleşmesi değildir".
//
// NEDEN ŞART: `seq` UInt64'tür ve zarfa `Number` olarak konuyordu. JavaScript
// güvenli tamsayı sınırı 2^53 (9007199254740991); canlı veritabanında en
// büyük seq 1.15e18, yani sınırın 128 KATI. 4393 olayın 2846'sı sınır
// üstündeydi ve kırpma sonrası geriye 685 benzersiz değer kalıyordu. Panel
// olayları `seq` eşitliğiyle tekilleştirdiği için gerisini ATIYORDU —
// "bağlı görünen ama ölü sistem" sınıfının ders kitabı örneği.
//
// Çözüm dokümanın zaten söylediği şey: imleci OPAK METİN olarak taşı.

/** UInt64 seq'i kayıpsız imlece çevirir. */
export function toCursor(seq: string | bigint | number): string {
  return BigInt(seq).toString();
}
