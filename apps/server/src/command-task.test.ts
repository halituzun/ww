import { describe, expect, it } from 'vitest';
import {
  CommandTaskError,
  NO_TARGET_NOTE,
  buildCommandTask,
  filesInCommand,
} from './command-task.js';

describe('filesInCommand', () => {
  it('emirdeki dosya yollarini bulur', () => {
    expect(filesInCommand('src/index.html dosyasina baslik ekle'))
      .toEqual(['src/index.html']);
  });

  it('birden fazla dosyayi bulur', () => {
    expect(filesInCommand('src/a.ts ve src/b.ts guncelle')).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('ayni dosyayi tekrarlamaz', () => {
    expect(filesInCommand('index.html duzelt, index.html tekrar bak')).toEqual(['index.html']);
  });

  it('dosya yoksa bos doner', () => {
    expect(filesInCommand('her seyi daha guzel yap')).toEqual([]);
  });
});

describe('buildCommandTask', () => {
  it('emirden gorev tanimi uretir', () => {
    const spec = buildCommandTask('src/index.html dosyasina Yapilacaklar basligi ekle')!;
    expect(spec.targetFiles).toEqual(['src/index.html']);
    expect(spec.description).toContain('Yapilacaklar basligi ekle');
  });

  it('basligi emrin ilk cumlesinden alir', () => {
    expect(buildCommandTask('index.html duzelt. Sonra test yaz.')!.title)
      .toBe('index.html duzelt');
  });

  it('cok uzun basligi kisaltir', () => {
    const spec = buildCommandTask(`${'a'.repeat(200)} index.html`)!;
    expect(spec.title.length).toBeLessThanOrEqual(80);
  });

  // Hedefi olmayan görev hiçbir dosya yazamaz ama kullanıcıya "iş açıldı"
  // der. Bu yüzden görev AÇILMAZ — ama emir bir hata da değildir: docs/08 PM
  // ile sohbeti de tanımlar, her mesaj dosya düzenleme emri değildir.
  it('hedef dosya gecmeyen emirde gorev acmaz ama hata da vermez', () => {
    expect(buildCommandTask('her seyi daha guzel yap')).toBeNull();
  });

  it('gorev acilmadigini soyleyecek bir not sunar', () => {
    expect(NO_TARGET_NOTE).toMatch(/görev açılmadı/);
    expect(NO_TARGET_NOTE).toMatch(/dosyayı adıyla/);
  });

  it('bos emri reddeder', () => {
    expect(() => buildCommandTask('   ')).toThrow(CommandTaskError);
  });

  it('kabul kriterini hedef dosyalara baglar', () => {
    expect(buildCommandTask('src/a.ts guncelle')!.acceptanceCriteria)
      .toEqual(['src/a.ts emre uygun güncellendi']);
  });
});
