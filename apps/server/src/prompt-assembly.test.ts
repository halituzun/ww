import { describe, expect, it } from 'vitest';
import { assemblePromptMessages, renderPromptTemplate } from './prompt-assembly.js';

const brief = {
  projectId: 'p1', taskId: 't1', taskBriefId: 'b1',
  goal: 'Satranç tahtasını çiz',
  acceptanceCriteria: ['8x8 kare görünür', 'taşlar başlangıç dizilişinde'],
  targetFiles: ['src/Board.tsx'],
  allowedTools: ['read_file', 'write_file'],
  tokenBudget: 50_000,
} as never;

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
    const messages = assemblePromptMessages({ brief, template, contextPack: 'geçmiş yok' });
    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages[0]!.role).toBe('system');
    expect(messages.at(-1)!.role).toBe('user');
  });

  it('görev hedefini ve kabul kriterlerini prompta koyar', () => {
    const messages = assemblePromptMessages({ brief, template, contextPack: '' });
    const text = messages.map((m) => m.content).join('\n');
    expect(text).toContain('Satranç tahtasını çiz');
    expect(text).toContain('8x8 kare görünür');
  });

  // Hedef dosyalar ve izinli araçlar brifte mühürlüdür; worker'ın kapsam
  // dışına çıkmaması için prompta girmeli.
  it('hedef dosyaları ve izinli araçları bildirir', () => {
    const text = assemblePromptMessages({ brief, template, contextPack: '' })
      .map((m) => m.content).join('\n');
    expect(text).toContain('src/Board.tsx');
    expect(text).toContain('write_file');
  });

  it('bağlam paketini şablona yerleştirir', () => {
    const text = assemblePromptMessages({ brief, template, contextPack: 'ÖNCEKİ KARAR: tailwind' })
      .map((m) => m.content).join('\n');
    expect(text).toContain('ÖNCEKİ KARAR: tailwind');
  });

  it('boş şablonu reddeder', () => {
    expect(() => assemblePromptMessages({ brief, template: '   ', contextPack: '' }))
      .toThrow(/şablon/i);
  });

  // Şema en az bir mesaj ister; boş üretim mühürlemeyi sessizce bozardı.
  it('her zaman en az bir mesaj döner', () => {
    expect(assemblePromptMessages({ brief, template, contextPack: '' }).length)
      .toBeGreaterThan(0);
  });

  it('kabul kriteri yoksa prompt yine geçerli kalır', () => {
    const bare = { ...brief, acceptanceCriteria: [] } as never;
    const messages = assemblePromptMessages({ brief: bare, template, contextPack: '' });
    expect(messages.every((m) => m.content.trim().length > 0)).toBe(true);
  });
});
