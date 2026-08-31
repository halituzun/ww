import { describe, expect, it } from 'vitest';
import { StrictJsonError, toStrictJson } from './strict-json.js';

describe('toStrictJson', () => {
  // ASIL KUSUR: sonuçtaki tek bir undefined alan tüm sağlayıcı efektini
  // 'uncertain' yapıyor ve model çağrısı hiç tamamlanmıyordu.
  it('tanımsız nesne alanlarını düşürür', () => {
    expect(toStrictJson({ content: undefined, tokens: 5 })).toEqual({ tokens: 5 });
  });

  it('iç içe tanımsız alanları da düşürür', () => {
    expect(toStrictJson({ result: { text: 'a', error: undefined } }))
      .toEqual({ result: { text: 'a' } });
  });

  it('null’u korur', () => {
    expect(toStrictJson({ error: null })).toEqual({ error: null });
  });

  // Dizide undefined'ı düşürmek indeksleri kaydırırdı.
  it('dizideki tanımsızı null yapar, indeksi kaydırmaz', () => {
    expect(toStrictJson(['a', undefined, 'b'])).toEqual(['a', null, 'b']);
  });

  it('sayı, metin ve mantıksal değerleri geçirir', () => {
    expect(toStrictJson({ a: 1, b: 'x', c: true })).toEqual({ a: 1, b: 'x', c: true });
  });

  // Kalıcı kayıtta sessiz veri kaybı teşhis edilemez bir hata sınıfıdır.
  it('fonksiyonu sessizce düşürmez, açık hata verir', () => {
    expect(() => toStrictJson({ run: () => 1 })).toThrow(StrictJsonError);
  });

  it('bigint için açık hata verir', () => {
    expect(() => toStrictJson({ n: 1n })).toThrow(/bigint/);
  });

  it('sonlu olmayan sayı için açık hata verir', () => {
    expect(() => toStrictJson({ n: Number.NaN })).toThrow(/sonlu olmayan/);
  });

  // Hatanın nerede olduğunu söylemeyen mesaj teşhisi zorlaştırır.
  it('hata mesajı alanın yolunu içerir', () => {
    expect(() => toStrictJson({ result: { usage: { total: Number.POSITIVE_INFINITY } } }))
      .toThrow(/result\.usage\.total/);
  });

  it('kök seviyesindeki undefined’ı reddeder', () => {
    expect(() => toStrictJson(undefined)).toThrow(/undefined/);
  });
});
