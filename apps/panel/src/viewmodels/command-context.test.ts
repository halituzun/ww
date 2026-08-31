import { describe, expect, it } from 'vitest';
import { commandScreenContext, withScreenContext } from './command-context.js';

describe('commandScreenContext (docs/10: "aktif ekran bağlamı emre iliştirilir")', () => {
  it('web onizleme acikken URLyi bildirir', () => {
    expect(commandScreenContext({ tab: 'preview', previewUrl: 'http://localhost:42001/' }))
      .toContain('http://localhost:42001/');
  });

  it('cihaz oturumu acikken oturumu bildirir', () => {
    const context = commandScreenContext({ tab: 'preview', mobileSessionId: '127.0.0.1:26624' });
    expect(context).toContain('cihaz');
    expect(context).toContain('127.0.0.1:26624');
  });

  it('hangi sekmenin acik oldugunu her zaman bildirir', () => {
    expect(commandScreenContext({ tab: 'files' })).toContain('files');
  });

  // İkisi birden açıksa İKİSİ de bildirilir: PM hangisinden bahsedildiğini
  // ancak böyle sorabilir.
  it('web ve cihaz birlikte acikken ikisini de bildirir', () => {
    const context = commandScreenContext({
      tab: 'preview', previewUrl: 'http://localhost:42001/', mobileSessionId: 's1',
    });
    expect(context).toContain('42001');
    expect(context).toContain('s1');
  });
});

describe('withScreenContext', () => {
  it('emre baglami AYRI bir blok olarak ekler', () => {
    const text = withScreenContext('butonu büyüt', 'Açık sekme: preview');
    expect(text).toContain('butonu büyüt');
    expect(text).toContain('Açık sekme: preview');
    // Bağlam emirden AYRILIR: karıştırmak PM'e kullanıcının yazdığı sanılan
    // bir metin verirdi.
    expect(text.indexOf('butonu büyüt')).toBeLessThan(text.indexOf('Açık sekme'));
  });

  it('baglam yoksa emri DEGISTIRMEZ', () => {
    expect(withScreenContext('butonu büyüt', '')).toBe('butonu büyüt');
  });
});
