// Çalışma alanı yüklemesinin sonuç değerlendirmesi (docs/09 ViewModel katmanı).
//
// NEDEN VAR: `/usage`, `/provider-health` ve `/artifacts` uçları hatayı
// YUTUYORDU. Sağlayıcı sağlığı alınamadığında hiç rozet çizilmiyordu ve
// rozetin YOKLUĞU kullanıcıya "her şey yolunda" diye okunuyor — oysa docs/04
// "düşen sağlayıcı panelde KIRMIZI görünür" diyor.
//
// Hepsini tek `Promise.all` ile reddettirmek de çözüm değildi: bir uç
// düşünce görevler ve dosyalar da güncellenmez, panel sessizce donardı.
// Bu yüzden her uç AYRI değerlendirilir: geleni göster, düşeni SÖYLE.

/** Düşen yüzeyleri kullanıcıya adıyla bildirir; hepsi geldiyse mesaj yok. */
export function describeLoadFailures(failed: readonly string[]): string {
  if (failed.length === 0) return '';
  return `Alınamadı: ${failed.join(', ')}`;
}
