import { describe, expect, it } from 'vitest';
import { MobileSessionRegistry } from './mobile-sessions.js';

const project = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';

describe('MobileSessionRegistry (docs/10: proje başına en çok 1 emülatör süreci)', () => {
  it('projeye oturum baglar ve geri verir', () => {
    const registry = new MobileSessionRegistry();
    registry.bind(project, 's1');
    expect(registry.projectOf('s1')).toBe(project);
  });

  // docs/10 kaynak koruması: aynı projede ikinci oturum AÇILAMAZ. Sınırsız
  // oturum, her tıklamada yeni emülatör açardı.
  it('ayni projede ikinci oturumu reddeder', () => {
    const registry = new MobileSessionRegistry();
    registry.bind(project, 's1');
    expect(() => registry.assertFree(project)).toThrow(/zaten açık/i);
  });

  it('farkli projeler birbirini engellemez', () => {
    const registry = new MobileSessionRegistry();
    registry.bind(project, 's1');
    expect(() => registry.assertFree(other)).not.toThrow();
  });

  it('serbest birakinca yeniden acilabilir', () => {
    const registry = new MobileSessionRegistry();
    registry.bind(project, 's1');
    registry.release('s1');
    expect(registry.projectOf('s1')).toBeUndefined();
    expect(() => registry.assertFree(project)).not.toThrow();
  });

  // Projesiz oturum meşrudur (panel proje seçmeden de cihaz açabilir); ama
  // sınır YALNIZCA projeli oturumlara uygulanır.
  it('projesiz oturum sinira takilmaz', () => {
    const registry = new MobileSessionRegistry();
    registry.bind(undefined, 's1');
    expect(registry.projectOf('s1')).toBeUndefined();
    expect(() => registry.assertFree(project)).not.toThrow();
  });
});
