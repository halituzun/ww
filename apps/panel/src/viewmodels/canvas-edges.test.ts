import { describe, expect, it } from 'vitest';
import { taskCanvasEdges } from './canvas-edges.js';

const task = (id: string, over: Record<string, unknown> = {}) => ({
  task_id: id, status: 'queued', ...over,
});

describe('taskCanvasEdges', () => {
  // ASIL KUSUR: tuval ardışık görevleri bağlıyordu — uydurma bağımlılık.
  it('ilişkisiz görevler arasında ok çizmez', () => {
    expect(taskCanvasEdges([task('a'), task('b'), task('c')])).toEqual([]);
  });

  it('bağımlılıktan hedefe ok çizer', () => {
    const edges = taskCanvasEdges([task('a'), task('b', { depends_on: ['a'] })]);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ source: 'a', target: 'b', kind: 'depends' });
  });

  // docs/08'in asıl sorusu: kim kime iş verdi.
  it('delegasyonu ebeveynden çocuğa çizer', () => {
    const edges = taskCanvasEdges([task('p'), task('c', { parent_task_id: 'p' })]);
    expect(edges[0]).toMatchObject({ source: 'p', target: 'c', kind: 'delegates' });
  });

  // Boşluğa çizilen ok grafiği yalancı yapar.
  it('bilinmeyen göreve ok çizmez', () => {
    expect(taskCanvasEdges([task('b', { depends_on: ['yok'] })])).toEqual([]);
  });

  it('NIL referansları yok sayar', () => {
    const nil = '00000000-0000-0000-0000-000000000000';
    expect(taskCanvasEdges([task('a', { parent_task_id: nil, depends_on: [nil] })])).toEqual([]);
  });

  it('kendine ok çizmez', () => {
    expect(taskCanvasEdges([task('a', { depends_on: ['a'] })])).toEqual([]);
  });

  it('aynı ilişkiyi iki kez çizmez', () => {
    expect(taskCanvasEdges([task('a'), task('b', { depends_on: ['a', 'a'] })])).toHaveLength(1);
  });

  // Hareketli ok "şu an çalışıyor" demektir; duran işi hareketli göstermek yanıltır.
  it('yalnızca aktif hedefin okunu hareketlendirir', () => {
    const working = taskCanvasEdges([task('a'), task('b', { depends_on: ['a'], status: 'working' })]);
    const idle = taskCanvasEdges([task('a'), task('b', { depends_on: ['a'], status: 'queued' })]);
    expect(working[0]!.animated).toBe(true);
    expect(idle[0]!.animated).toBe(false);
  });

  it('hem bağımlılık hem delegasyonu birlikte çizer', () => {
    const edges = taskCanvasEdges([
      task('p'), task('a'), task('c', { parent_task_id: 'p', depends_on: ['a'] }),
    ]);
    expect(edges.map((edge) => edge.kind).sort()).toEqual(['delegates', 'depends']);
  });
});
