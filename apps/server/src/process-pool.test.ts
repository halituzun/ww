import { describe, expect, it } from 'vitest';
import {
  OUTPUT_RING_LIMIT,
  OutputRing,
  PORT_POOL_END,
  PORT_POOL_START,
  PortPool,
  PortPoolError,
} from './process-pool.js';

describe('PortPool', () => {
  it('havuzun basindan port atar', () => {
    expect(new PortPool().assign('p1')).toBe(PORT_POOL_START);
  });

  // Yeniden başlatmada portun değişmesi paneldeki iframe'i sessizce kırardı.
  it('ayni anahtara ayni portu doner', () => {
    const pool = new PortPool();
    expect(pool.assign('p1')).toBe(pool.assign('p1'));
  });

  it('farkli anahtarlara farkli port verir', () => {
    const pool = new PortPool();
    expect(pool.assign('p1')).not.toBe(pool.assign('p2'));
  });

  it('birakilan port yeniden kullanilir', () => {
    const pool = new PortPool();
    const first = pool.assign('p1');
    pool.release('p1');
    expect(pool.assign('p2')).toBe(first);
  });

  it('atanmamis anahtar icin port bildirmez', () => {
    expect(new PortPool().portOf('yok')).toBeUndefined();
  });

  // Havuz tükenince sessizce havuz dışına taşmak, başka servislerin portlarını
  // çalmak demektir.
  it('havuz tukendiginde acik hata verir', () => {
    const pool = new PortPool();
    for (let index = 0; index <= PORT_POOL_END - PORT_POOL_START; index += 1) {
      pool.assign(`p${index}`);
    }
    expect(() => pool.assign('tasan')).toThrow(PortPoolError);
  });
});

describe('OutputRing', () => {
  it('satirlari sirasiyla tutar', () => {
    const ring = new OutputRing();
    ring.push('bir\niki\n');
    expect(ring.lines()).toEqual(['bir', 'iki']);
  });

  it('bos satirlari atar', () => {
    const ring = new OutputRing();
    ring.push('bir\n\n  \niki');
    expect(ring.lines()).toEqual(['bir', 'iki']);
  });

  // Çöken süreçte SON satırlar tanısaldır; eski olanlar düşmelidir.
  it('sinir asilinca en eski satiri dusurur', () => {
    const ring = new OutputRing(2);
    ring.push('a\nb\nc');
    expect(ring.lines()).toEqual(['b', 'c']);
  });

  it('gecersiz sinirda varsayilana duser', () => {
    const ring = new OutputRing(0);
    for (let index = 0; index < OUTPUT_RING_LIMIT + 5; index += 1) ring.push(`satir${index}`);
    expect(ring.lines()).toHaveLength(OUTPUT_RING_LIMIT);
  });

  it('donen listeyi disaridan degistirmeye izin vermez', () => {
    const ring = new OutputRing();
    ring.push('a');
    expect(() => (ring.lines() as string[]).push('b')).toThrow();
  });
});

describe('PortPool — kayıtlı port tercihi', () => {
  // Süreç yeniden başlayınca portun değişmesi paneldeki iframe'i sessizce
  // kırar; docs/05 portu projeye yazmayı bu yüzden şart koşuyor.
  it('kayitli portu yeniden kullanir', () => {
    expect(new PortPool().assign('p1', 42_042)).toBe(42_042);
  });

  // Başkası tutuyorsa kayıtlı portu vermek iki sunucuyu aynı porta koyardı.
  it('baskasi tutuyorsa kayitli portu vermez', () => {
    const pool = new PortPool();
    pool.assign('p1', 42_042);
    expect(pool.assign('p2', 42_042)).not.toBe(42_042);
  });

  // Havuz dışındaki port başka bir servisin portunu çalmak olurdu.
  it('havuz disindaki tercihi yok sayar', () => {
    expect(new PortPool().assign('p1', 80)).toBe(PORT_POOL_START);
  });
});
