import { describe, expect, it } from 'vitest';
import { RUNTIME_SERVICE_NAME, internalServiceTokenMap } from './internal-service-tokens.js';

describe('internalServiceTokenMap', () => {
  // ASIL KUSUR: harita üretimde HİÇ doldurulmuyordu; runtime'ın her iç servis
  // çağrısı "internal service token gecersiz" ile reddediliyordu.
  it('runtime belirtecini servis adına eşler', () => {
    const map = internalServiceTokenMap('gizli-belirteç');
    expect(map.get('gizli-belirteç')).toBe(RUNTIME_SERVICE_NAME);
  });

  // GÜVENLİK: boş belirteç eşleşirse, kimlik bilgisi olmayan HERKES runtime
  // servisi gibi davranabilir. Boş anahtar haritaya asla girmemeli.
  it('boş belirteci haritaya koymaz', () => {
    expect(internalServiceTokenMap('').size).toBe(0);
  });

  it('yalnızca boşluktan oluşan belirteci de reddeder', () => {
    expect(internalServiceTokenMap('   ').size).toBe(0);
  });

  it('tanımsız belirteçte boş harita döner', () => {
    expect(internalServiceTokenMap(undefined).size).toBe(0);
  });

  it('haritada yalnızca tek giriş bulunur', () => {
    expect(internalServiceTokenMap('t').size).toBe(1);
  });
});
