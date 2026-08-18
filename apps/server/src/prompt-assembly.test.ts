import { describe, expect, it } from 'vitest';
import { assemblePromptMessages, renderPromptTemplate } from './prompt-assembly.js';

const BASE_BRIEF = {
  projectId: 'p1', taskId: 't1', taskBriefId: 'b1',
  goal: 'Satranç tahtasını çiz',
  acceptanceCriteria: ['8x8 kare görünür', 'taşlar başlangıç dizilişinde'],
  targetFiles: ['src/Board.tsx'],
  allowedTools: ['read_file', 'write_file'],
  tokenBudget: 50_000,
};

const brief = (over: Partial<typeof BASE_BRIEF> = {}) => ({ ...BASE_BRIEF, ...over });

describe('renderPromptTemplate', () => {
  it('değişkenleri doldurur', () => {
    expect(renderPromptTemplate('Merhaba {{name}}, {{n}} görev var', { name: 'ww', n: '3' }))
      .toBe('Merhaba ww, 3 görev var');
  });

  it('aynı değişkeni birden çok kez doldurur', () => {
    expect(renderPromptTemplate('{{x}}-{{x}}', { x: 'a' })).toBe('a-a');
  });

  // Doldurulmamış yer tutucu modele '{{context_pack}}' diye ham metin gider;
  // sessizce geçmek yerine hata vermek doğrusudur.
  it('eksik değişkeni sessizce geçmez', () => {
    expect(() => renderPromptTemplate('{{a}} ve {{b}}', { a: '1' })).toThrow(/b/);
  });

  it('değişkensiz şablonu olduğu gibi döner', () => {
    expect(renderPromptTemplate('düz metin', {})).toBe('düz metin');
  });
});

describe('assemblePromptMessages', () => {
  const template = 'Rol: worker\nGörev: {{task_description}}\nKriterler: {{acceptance_criteria}}\nBağlam: {{context_pack}}';

  it('system ve user mesajı üretir', () => {
    const messages = assemblePromptMessages({ brief: brief() as never, template, contextPack: 'geçmiş yok' });
    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages[0]!.role).toBe('system');
    expect(messages.at(-1)!.role).toBe('user');
  });

  it('görev hedefini ve kabul kriterlerini prompta koyar', () => {
    const messages = assemblePromptMessages({ brief: brief() as never, template, contextPack: '' });
    const text = messages.map((m) => m.content).join('\n');
    expect(text).toContain('Satranç tahtasını çiz');
    expect(text).toContain('8x8 kare görünür');
  });

  // Hedef dosyalar ve izinli araçlar brifte mühürlüdür; worker'ın kapsam
  // dışına çıkmaması için prompta girmeli.
  it('hedef dosyaları ve izinli araçları bildirir', () => {
    const text = assemblePromptMessages({ brief: brief() as never, template, contextPack: '' })
      .map((m) => m.content).join('\n');
    expect(text).toContain('src/Board.tsx');
    expect(text).toContain('write_file');
  });

  it('bağlam paketini şablona yerleştirir', () => {
    const text = assemblePromptMessages({ brief: brief() as never, template, contextPack: 'ÖNCEKİ KARAR: tailwind' })
      .map((m) => m.content).join('\n');
    expect(text).toContain('ÖNCEKİ KARAR: tailwind');
  });

  it('boş şablonu reddeder', () => {
    expect(() => assemblePromptMessages({ brief: brief() as never, template: '   ', contextPack: '' }))
      .toThrow(/şablon/i);
  });

  // Şema en az bir mesaj ister; boş üretim mühürlemeyi sessizce bozardı.
  it('her zaman en az bir mesaj döner', () => {
    expect(assemblePromptMessages({ brief: brief() as never, template, contextPack: '' }).length)
      .toBeGreaterThan(0);
  });

  it('kabul kriteri yoksa prompt yine geçerli kalır', () => {
    const bare = { ...brief(), acceptanceCriteria: [] } as never;
    const messages = assemblePromptMessages({ brief: bare, template, contextPack: '' });
    expect(messages.every((m) => m.content.trim().length > 0)).toBe(true);
  });

  // ASIL KUSUR: görevin HEDEFİ worker'a hiç ulaşmıyordu. Şablon değişkenleri
  // yalnızca sistem metnine konur; bootstrap şablonlarında hiç yer tutucu yok.
  // Sonuç: worker "bana görev verilmemiş" diye soru soruyor, hiçbir koşu
  // ilerlemiyordu. Hedef, şablondan BAĞIMSIZ olarak iletilmelidir.
  it('gorev hedefini sablondan bagimsiz olarak iletir', () => {
    const messages = assemblePromptMessages({
      template: 'Sen bir worker agent’sın.',
      brief: brief({ goal: 'src/colors.ts dosyasini olustur' }) as never,
      contextPack: '',
    });

    expect(messages.map((message) => message.content).join('\n'))
      .toContain('src/colors.ts dosyasini olustur');
  });

  it('kabul kriterlerini de iletir', () => {
    const messages = assemblePromptMessages({
      template: 'Sen bir worker agent’sın.',
      brief: brief({ acceptanceCriteria: ['squareColor light/dark doner'] }) as never,
      contextPack: '',
    });

    expect(messages.map((message) => message.content).join('\n'))
      .toContain('squareColor light/dark doner');
  });

  // Hedef boş gelirse worker'a sahte bir görev uydurulmamalı; eksiklik
  // AÇIKÇA görünmelidir.
  it('hedef bos oldugunda uydurmaz', () => {
    const messages = assemblePromptMessages({
      template: 'Sen bir worker agent’sın.',
      brief: brief({ goal: '   ' }) as never,
      contextPack: '',
    });
    const text = messages.map((message) => message.content).join('\n');
    expect(text).toMatch(/belirtilmedi|verilmedi/i);
  });

  // ASIL KUSUR: boş hedef listesi worker'a "(kısıt yok)" diye gösteriliyordu.
  // Oysa executor boş listeyi "hiçbir dosya yazılamaz" diye uygular ve
  // write_file'ı "mühürlü görev hedeflerinde değil" ile reddeder. Worker
  // yalana güvenip yazmayı denedi, reddedildi ve görev takıldı.
  it('bos hedef listesini kisit yok diye sunmaz', () => {
    const messages = assemblePromptMessages({
      template: 'Sen bir worker agent’sın.',
      brief: brief({ targetFiles: [] }) as never,
      contextPack: '',
    });
    const text = messages.map((message) => message.content).join('\n');

    expect(text).not.toContain('Hedef dosyalar:\n- (kısıt yok)');
    expect(text).toMatch(/hedef dosya (bildirilmedi|yok)/i);
  });

  it('hedef dosyalar bildirildiginde onlari listeler', () => {
    const messages = assemblePromptMessages({
      template: 'Sen bir worker agent’sın.',
      brief: brief({ targetFiles: ['src/colors.ts'] }) as never,
      contextPack: '',
    });
    expect(messages.map((message) => message.content).join('\n')).toContain('src/colors.ts');
  });

  // docs/05 Çalıştırma/Test Kapısı: "Hata → TAM ÇIKTI worker'a döner
  // (`testing → working`), attempt++". Dönmüyordu: yeniden denenen worker'ın
  // prompt'u ilk denemeyle byte byte aynıydı. Yani worker göremediği bir
  // hatayı düzeltmeye çağrılıyor ve üç denemenin biri her seferinde boşa
  // gidiyordu.
  it('onceki denemenin hatasini prompta koyar', () => {
    const messages = assemblePromptMessages({
      brief: brief() as never,
      template,
      contextPack: '',
      priorFailure: {
        attempt: 1,
        reason: "tsc --noEmit düştü:\nsrc/Board.tsx(4,7): error TS2304: Cannot find name 'Squares'.",
      },
    });
    const text = messages.map((m) => m.content).join('\n');
    expect(text).toContain('TS2304');
    expect(text).toContain('src/Board.tsx(4,7)');
    // Kaçıncı deneme olduğu da söylenir: worker "aynı şeyi tekrar dene"
    // ile "düzelt" arasındaki farkı ancak böyle bilir.
    expect(text).toMatch(/1\. deneme/);
  });

  it('ilk denemede onceki hata bolumu HIC olusmaz', () => {
    const messages = assemblePromptMessages({ brief: brief() as never, template, contextPack: '' });
    const text = messages.map((m) => m.content).join('\n');
    expect(text).not.toContain('Önceki deneme');
  });

  // Boş/beyaz sebep bölüm başlığı üretmemeli: "Önceki deneme başarısız oldu"
  // deyip sebebi söylememek, worker'ı yanlış yönlendirir.
  it('bos sebep icin bolum olusturmaz', () => {
    const messages = assemblePromptMessages({
      brief: brief() as never, template, contextPack: '',
      priorFailure: { attempt: 1, reason: '   ' },
    });
    expect(messages.map((m) => m.content).join('\n')).not.toContain('Önceki deneme');
  });
});
