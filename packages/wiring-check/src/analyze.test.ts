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

  // İlk sürümde bu beklenti tersineydi (kendi dosyasındaki kullanım bağlantı
  // sayılmıyordu). Kapı gerçek bir kod üzerinde denenince yanlış olduğu
  // görüldü: modülün kendi mantığı tarafından tüketilen sembol o mantık
  // üzerinden bağlıdır ve onu işaretlemek gürültü üretir.
  it('kendi modülünün mantığı tüketiyorsa bağlantısız saymaz', () => {
    const result = analyzeWiring([
      file('a.ts', 'export function helper() {}\nexport function inner() { return helper(); }'),
      file('b.ts', 'import { inner } from "./a.js"; inner();'),
      file('a.test.ts', 'import { helper } from "./a.js"; helper();'),
    ]);
    expect(result.unwired).toEqual([]);
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

describe('modül içi tüketim', () => {
  // Kendi modülünün mantığı tarafından kullanılan sabit "bağlantısız kod"
  // değildir; o mantık üzerinden bağlıdır. Böyle sinyaller gürültü üretir ve
  // gürültü kapıyı aşındırır.
  it('kendi dosyasında kullanılan sabiti bağlantısız saymaz', () => {
    const result = analyzeWiring([
      file('a.ts', 'export const LIMIT = 3;\nexport function take(xs: number[]) { return xs.slice(0, LIMIT); }'),
      file('b.ts', 'import { take } from "./a.js"; take([1]);'),
      file('a.test.ts', 'import { LIMIT, take } from "./a.js"; LIMIT; take([]);'),
    ]);
    expect(result.unwired).toEqual([]);
  });

  // Ama hiç kullanılmayan bir özellik yalnız tanımıyla durur: yakalanmalı.
  it('yalnız tanımlanıp hiç kullanılmayan özelliği yakalamaya devam eder', () => {
    const result = analyzeWiring([
      file('a.ts', 'export function lonely() { return 1; }'),
      file('a.test.ts', 'import { lonely } from "./a.js"; lonely();'),
    ]);
    expect(result.unwired).toEqual(['a.ts:lonely']);
  });
});

describe('gerekçeli istisna', () => {
  // Çıplak liste sessizce büyür. Gerekçe zorunluluğu, her istisnayı bilinçli
  // bir karar hâline getirir.
  it('metin ve gerekçeli girişleri birlikte okur', () => {
    const diff = diffAgainstBaseline(['a.ts:x', 'b.ts:y'], [
      'a.ts:x',
      { symbol: 'b.ts:y', reason: 'bootstrap sonraki turda bağlayacak' },
    ]);
    expect(diff.added).toEqual([]);
  });

  it('gerekçeli girişi de çözülmüş sayabilir', () => {
    const diff = diffAgainstBaseline([], [{ symbol: 'a.ts:x', reason: 'bekliyor' }]);
    expect(diff.resolved).toEqual(['a.ts:x']);
  });

  it('gerekçesiz nesne girişini yok sayar (sessiz istisna olmasın)', () => {
    const diff = diffAgainstBaseline(['a.ts:x'], [{ symbol: 'a.ts:x', reason: '' } as never]);
    expect(diff.added).toEqual(['a.ts:x']);
  });
});

// `appendSummary` tam bu kör noktadan saklandı: sınıf METODUYDU, hiçbir
// çağıranı yoktu ve kapı onu göremedi. Görülmediği için de gerçek tabloya hiç
// yazılmadığı (kolonları yanlış eşlediği) fark edilmemişti.
describe('sınıf metotları', () => {
  it('testte kullanilan ama uretimde cagrilmayan metodu bulur', () => {
    const report = analyzeWiring([
      { path: 'src/memory.ts', text: 'export class Memory {\n  async appendSummary(x: number) { return x; }\n}\n' },
      { path: 'src/memory.test.ts', text: 'new Memory().appendSummary(1);\n' },
    ]);
    expect(report.unwired).toContain('src/memory.ts:Memory.appendSummary');
  });

  it('uretimde cagrilan metodu bulgu saymaz', () => {
    const report = analyzeWiring([
      { path: 'src/memory.ts', text: 'export class Memory {\n  async appendSummary(x: number) { return x; }\n}\n' },
      { path: 'src/use.ts', text: 'declare const m: Memory; m.appendSummary(1);\n' },
      { path: 'src/memory.test.ts', text: 'new Memory().appendSummary(1);\n' },
    ]);
    expect(report.unwired).not.toContain('src/memory.ts:Memory.appendSummary');
  });

  // AYNI DOSYADAKİ başka bir sınıfın çağırması gerçek bir bağlantıdır.
  it('ayni dosyadaki cagriyi baglanti sayar', () => {
    const report = analyzeWiring([
      { path: 'src/preview.ts', text: 'export class Port {\n  screenshot() { return 1; }\n}\nexport class Service {\n  run(p: Port) { return p.screenshot(); }\n}\n' },
      { path: 'src/preview.test.ts', text: 'new Port().screenshot();\n' },
    ]);
    expect(report.unwired).not.toContain('src/preview.ts:Port.screenshot');
  });

  // Nest controller metotlarını FRAMEWORK çağırır, ad ile değil. Onları ihlal
  // saymak kapıyı gürültüye boğar ve gürültü kapıyı aşındırır.
  it('controller metotlarini bulgu saymaz', () => {
    const report = analyzeWiring([
      { path: 'src/audit.controller.ts', text: '@Controller()\nexport class AuditController {\n  report() { return 1; }\n}\n' },
      { path: 'src/audit.controller.test.ts', text: 'new AuditController().report();\n' },
    ]);
    expect(report.unwired).not.toContain('src/audit.controller.ts:AuditController.report');
  });


  // TEK SATIRLIK sınıf, genel desende `^}` bulunmadığı için bir sonraki
  // sınıfın gövdesini yutuyordu ve metot YANLIŞ SINIFA atfediliyordu.
  // Canlı örnek: `MobileSessionError.sessionOf` — o metot Registry'nindi.
  it('tek satirlik sinif sonraki sinifin gövdesini yutmaz', () => {
    const report = analyzeWiring([
      {
        path: 'src/reg.ts',
        text: [
          'export class RegError extends Error {}',
          '',
          'export class Registry {',
          '  bind(x: string) { return x; }',
          '}',
        ].join('\n'),
      },
      { path: 'src/reg.test.ts', text: 'new Registry().bind("a");\n' },
    ]);
    expect(report.unwired).toContain('src/reg.ts:Registry.bind');
    expect(report.unwired).not.toContain('src/reg.ts:RegError.bind');
  });

  it('framework yasam dongusu metotlarini bulgu saymaz', () => {
    const report = analyzeWiring([
      { path: 'src/pump.ts', text: 'export class Pump {\n  onModuleDestroy() { return 1; }\n}\n' },
      { path: 'src/pump.test.ts', text: 'new Pump().onModuleDestroy();\n' },
    ]);
    // Sınıfın kendisi ayrı bir bulgu olabilir; burada METODUN bulgu
    // sayılmadığını sabitliyoruz.
    expect(report.unwired).not.toContain('src/pump.ts:Pump.onModuleDestroy');
  });

  // ARAYÜZ üyesi metot değildir; onu sınıf gövdesi sanmak sahte bulgu üretir.
  it('interface uyelerini metot saymaz', () => {
    const report = analyzeWiring([
      { path: 'src/types.ts', text: 'export interface Provider {\n  embed(text: string): Promise<number[]>;\n}\n' },
      { path: 'src/types.test.ts', text: 'declare const p: Provider; p.embed("x");\n' },
    ]);
    expect(report.unwired).not.toContain('src/types.ts:Provider.embed');
  });
});
