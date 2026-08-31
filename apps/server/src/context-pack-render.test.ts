import { describe, expect, it } from 'vitest';
import { renderContextPack } from './context-pack-render.js';

const chunk = (over: Partial<Parameters<typeof renderContextPack>[0][number]>) => ({
  sourceTable: 'knowledge' as const, sourceId: 's1', text: 'React kullanılacak', label: 'karar', ...over,
});

describe('renderContextPack', () => {
  // ASIL KUSUR: bağlam paketi boş dize idi; agent sıfır proje bağlamıyla çalışıyordu.
  it('bilgi parçalarını başlıkla yazar', () => {
    const text = renderContextPack([chunk({})]);
    expect(text).toContain('Proje kararları');
    expect(text).toContain('React kullanılacak');
  });

  // Kaynak etiketi kopmamalı: model "bunu nereden biliyorum" diyebilmeli.
  it('kaynak etiketini korur', () => {
    expect(renderContextPack([chunk({ label: 'karar#12' })])).toContain('[karar#12]');
  });

  it('bölümleri sabit sırada verir', () => {
    const text = renderContextPack([
      chunk({ sourceTable: 'messages', text: 'm', label: 'msg' }),
      chunk({ sourceTable: 'knowledge', text: 'k', label: 'kar' }),
    ]);
    expect(text.indexOf('Proje kararları')).toBeLessThan(text.indexOf('İlgili yazışmalar'));
  });

  it('boş bölümü yazmaz', () => {
    expect(renderContextPack([chunk({})])).not.toContain('Dosya fihristi');
  });

  it('proje haritası bölümünü fihristten sonra yazar', () => {
    const text = renderContextPack([
      chunk({ sourceTable: 'project_maps', text: 'GET /api/health -> src/api.controller.ts:12', label: 'map#1' }),
      chunk({ sourceTable: 'file_index', text: 'src/api.controller.ts', label: 'file' }),
    ]);
    expect(text).toContain('## Proje haritası');
    expect(text.indexOf('Dosya fihristi')).toBeLessThan(text.indexOf('Proje haritası'));
  });

  // Bağlam yoksa boş dize doğrudur; uydurma başlık modele yanlış sinyal verir.
  it('parça yoksa boş döner', () => {
    expect(renderContextPack([])).toBe('');
  });

  it('metindeki fazla boşluğu kırpar', () => {
    expect(renderContextPack([chunk({ text: '  boşluklu  ' })])).toContain('- [karar] boşluklu');
  });
});
