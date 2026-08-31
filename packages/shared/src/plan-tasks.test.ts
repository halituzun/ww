import { describe, it, expect } from 'vitest';
import {
  PlanTaskGraphError,
  parsePlanTasksFromMarkdown,
  readPlanTaskGraph,
  topologicalPlanTaskOrder,
  type PlanTaskSpecV1,
} from './plan-tasks.js';

const spec = (over: Partial<PlanTaskSpecV1> & { key: string }): PlanTaskSpecV1 => ({
  key: over.key,
  title: over.title ?? `${over.key} başlığı`,
  description: over.description ?? '',
  acceptanceCriteria: over.acceptanceCriteria ?? ['kriter'],
  targetFiles: over.targetFiles ?? ['src/a.ts'],
  dependsOn: over.dependsOn ?? [],
  group: over.group ?? 'coding',
});

describe('plan gorev grafigi', () => {
  it('bagimlilik sirasina gore dizer', () => {
    const ordered = topologicalPlanTaskOrder([
      spec({ key: 'c', dependsOn: ['b'] }),
      spec({ key: 'a' }),
      spec({ key: 'b', dependsOn: ['a'] }),
    ]);
    expect(ordered.map((t) => t.key)).toEqual(['a', 'b', 'c']);
  });

  it('bilinmeyen bagimliligi fail-closed reddeder', () => {
    expect(() => topologicalPlanTaskOrder([spec({ key: 'a', dependsOn: ['yok'] })]))
      .toThrow(PlanTaskGraphError);
  });

  it('donguyu fail-closed reddeder', () => {
    expect(() => topologicalPlanTaskOrder([
      spec({ key: 'a', dependsOn: ['b'] }),
      spec({ key: 'b', dependsOn: ['a'] }),
    ])).toThrow(/dongu/i);
  });

  it('tekrar eden anahtari reddeder', () => {
    expect(() => topologicalPlanTaskOrder([spec({ key: 'a' }), spec({ key: 'a' })]))
      .toThrow(/tekrar/i);
  });

  it('hedef dosyasi olmayan gorevi kabul etmez', () => {
    // Executor bos hedef listesini "hicbir dosya yazilamaz" diye uygular;
    // boyle bir gorev kuyruga girse hicbir sey uretemezdi.
    expect(() => readPlanTaskGraph({ tasks: [{ ...spec({ key: 'a' }), targetFiles: [] }] }))
      .toThrow(PlanTaskGraphError);
  });

  it('bos/eksik scenarios_json icin bos grafik dondurur', () => {
    expect(readPlanTaskGraph(undefined).tasks).toEqual([]);
    expect(readPlanTaskGraph({ scenarios: [] }).tasks).toEqual([]);
  });

  it('bozuk grafigi sessizce bos saymaz', () => {
    expect(() => readPlanTaskGraph({ tasks: [{ key: '' }] })).toThrow(PlanTaskGraphError);
    expect(() => readPlanTaskGraph('{bozuk')).toThrow(PlanTaskGraphError);
  });

  it('JSON metnini de cozer', () => {
    const graph = readPlanTaskGraph(JSON.stringify({ tasks: [spec({ key: 'a' })] }));
    expect(graph.tasks).toHaveLength(1);
  });
});

describe('nihai sentezden gorev ayristirma', () => {
  const markdown = `# plan

## Sentez (Nihai Karar & Görevler)

BULGU 1: bir sey
KARAR: KABUL

## GÖREVLER

### GÖREV g1 — Oyun tahtasini ciz
DOSYALAR: src/board.ts, src/styles.css
KABUL: 10x20 izgara cizilir | bos hucreler gorunur
BAĞIMLI: -
GRUP: coding
AÇIKLAMA: Tahtayi DOM uzerinde olustur.

### GÖREV g2 — Parca dusurme dongusu
DOSYALAR: src/loop.ts
KABUL: parca saniyede bir asagi iner
BAĞIMLI: g1

## Tur 1 · Bağımsız Öneriler
`;

  it('gorevleri ve alanlarini okur', () => {
    const tasks = parsePlanTasksFromMarkdown(markdown);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.key).toBe('g1');
    expect(tasks[0]?.title).toBe('Oyun tahtasini ciz');
    expect(tasks[0]?.targetFiles).toEqual(['src/board.ts', 'src/styles.css']);
    expect(tasks[0]?.acceptanceCriteria).toHaveLength(2);
    expect(tasks[0]?.dependsOn).toEqual([]);
    expect(tasks[1]?.dependsOn).toEqual(['g1']);
  });

  it('sonraki ## bolumune tasmaz', () => {
    const tasks = parsePlanTasksFromMarkdown(markdown);
    expect(tasks.map((t) => t.key)).toEqual(['g1', 'g2']);
  });

  // Tireli anahtar: eski regex kimliği ilk tireden bölüyordu ('g-1' -> 'g').
  // Testler yalnız 'g1' kullandığı için hata kaçmıştı.
  it('tireli gorev anahtarini bolmez', () => {
    const tasks = parsePlanTasksFromMarkdown(
      '## GÖREVLER\n\n### GÖREV oyun-tahtasi — Tahtayi ciz\nDOSYALAR: src/board.ts\nKABUL: cizilir\n',
    );
    expect(tasks[0]?.key).toBe('oyun-tahtasi');
    expect(tasks[0]?.title).toBe('Tahtayi ciz');
  });

  it('GOREVLER bolumu yoksa bos doner', () => {
    expect(parsePlanTasksFromMarkdown('## Sentez\n\nmetin')).toEqual([]);
  });

  it('eksik alanli gorevi sessizce atlamaz', () => {
    // DOSYALAR yok: bu gorev calisamaz, onay aninda yakalanmali.
    expect(() => parsePlanTasksFromMarkdown(
      '## GÖREVLER\n\n### GÖREV g1 — Baslik\nKABUL: kriter\n',
    )).toThrow(PlanTaskGraphError);
  });
});
