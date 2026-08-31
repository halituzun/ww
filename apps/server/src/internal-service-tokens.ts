// İç servis belirteçlerinin kayıt yeri.
//
// NEDEN VAR: `PrincipalResolver` internal_service kimliğini bir belirteç→servis
// haritasına göre doğrular, ama bu harita üretimde HİÇ doldurulmuyordu.
// Sonuç: runtime'ın her iç çağrısı 'internal service token gecersiz' ile
// reddediliyor, worker döngüsü daha modele ulaşamadan düşüyordu.

/** Orkestrasyon runtime'ının iç servis adı. */
export const RUNTIME_SERVICE_NAME = 'ww-runtime';

/**
 * GÜVENLİK: boş/boşluk belirteç haritaya ASLA girmez. Girseydi, kimlik
 * bilgisi taşımayan her çağrı runtime servisi gibi doğrulanırdı.
 */
export function internalServiceTokenMap(token: string | undefined): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  if (token !== undefined && token.trim().length > 0) {
    map.set(token, RUNTIME_SERVICE_NAME);
  }
  return map;
}
