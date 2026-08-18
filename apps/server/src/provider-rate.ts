// Sağlayıcı istek/dakika ayarı (docs/04, docs/07).
//
// NEDEN AYRI: sınır bir GÜVENLİK VALFİDİR; bozuk yapılandırmanın onu sessizce
// kaldırması, sınırsız çıkışa dönerek 429 fırtınası yaratır. Bu yüzden
// ayrıştırma tek yerde ve testli.
export const DEFAULT_PROVIDER_RPM = 0;

export function providerRequestsPerMinute(
  raw: string | undefined = process.env['WW_PROVIDER_RPM'],
): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_PROVIDER_RPM;
  const parsed = Number(raw);
  // Bozuk değer "sınırsız"a düşer ama bu BİLİNÇLİ: varsayılan zaten
  // sınırsızdır ve sessizce DARALTMAK koşan işi durdurabilirdi.
  if (!Number.isSafeInteger(parsed) || parsed < 0) return DEFAULT_PROVIDER_RPM;
  return parsed;
}
