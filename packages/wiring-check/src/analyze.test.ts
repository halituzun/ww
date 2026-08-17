import { describe, expect, it } from 'vitest';
import { analyzeWiring, diffAgainstBaseline, type SourceFile } from './analyze.js';

const file = (path: string, text: string): SourceFile => ({ path, text });

describe('analyzeWiring', () => {
  it('üretimde kullanılan sembolü bağlantısız saymaz', () => {
    const result = analyzeWiring([
      file('a.ts', 'export function used() {}'),
      file('b.ts', 'import { used } from "./a.js"; used();'),
    ]);
    expect(result.unwired).toEqual([]);
  });

  // Aranan desen tam olarak bu: test var, üretim çağrısı yok.
  it('yalnız testte kullanılan sembolü bağlantısız sayar', () => {
    const result = analyzeWiring([
      file('a.ts', 'export function lonely() {}'),
      file('a.test.ts', 'import { lonely } from "./a.js"; lonely();'),
    ]);
    expect(result.unwired).toEqual(['a.ts:lonely']);
  });

  // Hiç kullanılmayan sembol farklı bir sorundur (ölü kod); bu kapı
  // "test var ama üretim bağlantısı yok" desenini hedefler.
  it('hiç kullanılmayan sembolü ayrı raporlar', () => {
    const result = analyzeWiring([file('a.ts', 'export function never() {}')]);
    expect(result.unwired).toEqual([]);
    expect(result.untested).toEqual(['a.ts:never']);
  });

  it('index.ts yeniden dışa açmayı kullanım saymaz', () => {
    const result = analyzeWiring([
      file('pkg/a.ts', 'export function lonely() {}'),
      file('pkg/index.ts', 'export * from "./a.js";'),
      file('pkg/a.test.ts', 'import { lonely } from "./a.js"; lonely();'),
    ]);
    expect(result.unwired).toEqual(['pkg/a.ts:lonely']);
  });

  it('tsx dosyalarındaki kullanımı sayar', () => {
    const result = analyzeWiring([
      file('svc.ts', 'export function load() {}'),
      file('View.tsx', 'import { load } from "./svc.js"; load();'),
    ]);
    expect(result.unwired).toEqual([]);
  });

  it('class ve const dışa açmalarını da tarar', () => {
    const result = analyzeWiring([
      file('a.ts', 'export class Widget {}\nexport const LIMIT = 3;'),
      file('a.test.ts', 'import { Widget, LIMIT } from "./a.js"; new Widget(); LIMIT;'),
    ]);
    expect(result.unwired.sort()).toEqual(['a.ts:LIMIT', 'a.ts:Widget']);
  });

  it('tanımlandığı dosyadaki kendi kullanımını bağlantı saymaz', () => {
    const result = analyzeWiring([
      file('a.ts', 'export function helper() {}\nfunction inner() { return helper(); }\nexport { inner };'),
      file('a.test.ts', 'import { helper } from "./a.js"; helper();'),
    ]);
    expect(result.unwired).toContain('a.ts:helper');
  });
});

describe('diffAgainstBaseline', () => {
  it('temel listedeki bilinen bağlantısızları geçirir', () => {
    const diff = diffAgainstBaseline(['a.ts:x'], ['a.ts:x']);
    expect(diff.added).toEqual([]);
  });

  // Kapının amacı: yeni bağlantısız kod EKLENMESİNİ engellemek.
  it('temel listede olmayan yeni bağlantısızı yakalar', () => {
    const diff = diffAgainstBaseline(['a.ts:x', 'b.ts:y'], ['a.ts:x']);
    expect(diff.added).toEqual(['b.ts:y']);
  });

  // Bağlanan sembol temel listeden düşürülmeli ki liste zamanla erisin.
  it('artık bağlantısız olmayanları çözülmüş sayar', () => {
    const diff = diffAgainstBaseline(['a.ts:x'], ['a.ts:x', 'b.ts:y']);
    expect(diff.resolved).toEqual(['b.ts:y']);
  });

  it('hem yeni hem çözülmüş aynı anda raporlanır', () => {
    const diff = diffAgainstBaseline(['b.ts:y'], ['a.ts:x']);
    expect(diff.added).toEqual(['b.ts:y']);
    expect(diff.resolved).toEqual(['a.ts:x']);
  });
});
