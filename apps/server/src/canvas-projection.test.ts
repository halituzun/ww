import { describe, expect, it } from 'vitest';
import { buildCanvasProjection } from './canvas-projection.js';

const NIL = '00000000-0000-0000-0000-000000000000';

const agent = (id: string, over: Partial<Parameters<typeof buildCanvasProjection>[0][number]> = {}) => ({
  agent_id: id, role: 'worker', group: 'coding', name: `Agent ${id}`,
  model_ref: 'deepseek:deepseek-chat', parent_agent_id: NIL, clone_of: NIL,
  status: 'idle', current_task_id: NIL, ...over,
});

const task = (id: string, over: Partial<Parameters<typeof buildCanvasProjection>[1][number]> = {}) => ({
  task_id: id, title: 'iş', status: 'working',
  issuer_agent_id: NIL, worker_agent_id: NIL, verifier_agent_id: NIL, ...over,
});

describe('buildCanvasProjection', () => {
  it('her agent icin dugum uretir', () => {
    const canvas = buildCanvasProjection([agent('a1'), agent('a2')], []);
    expect(canvas.nodes.map((node) => node.id)).toEqual(['a1', 'a2']);
    expect(canvas.nodes[0]!.modelRef).toBe('deepseek:deepseek-chat');
  });

  it('hiyerarsi kenarini parent alanindan turer', () => {
    const canvas = buildCanvasProjection(
      [agent('pm', { role: 'pm' }), agent('w1', { parent_agent_id: 'pm' })], []);
    expect(canvas.edges).toEqual([expect.objectContaining({
      source: 'pm', target: 'w1', kind: 'hierarchy', animated: false,
    })]);
  });

  it('hiçbir yan rol (görüşmeci, anlatıcı, özetleyici, araştırmacı) hiyerarşide parent olamaz', () => {
    const canvas = buildCanvasProjection([
      agent('pm', { role: 'pm' }),
      agent('interviewer', { role: 'interviewer' }),
      agent('narrator', { role: 'narrator' }),
      agent('v2', { role: 'verifier', parent_agent_id: 'interviewer' }),
      agent('w2', { role: 'worker', parent_agent_id: 'narrator' }),
    ], []);

    const hierarchyEdges = canvas.edges.filter((e) => e.kind === 'hierarchy');
    const sources = hierarchyEdges.map((e) => e.source);

    // Hiçbir yan rol source (parent) olamaz
    expect(sources).not.toContain('interviewer');
    expect(sources).not.toContain('narrator');

    // v2 ve w2 doğrudan PM'e bağlanmalı
    expect(hierarchyEdges).toContainEqual(expect.objectContaining({ source: 'pm', target: 'v2', kind: 'hierarchy' }));
    expect(hierarchyEdges).toContainEqual(expect.objectContaining({ source: 'pm', target: 'w2', kind: 'hierarchy' }));
  });

  it('klon kenarini clone_of alanindan turer', () => {
    const canvas = buildCanvasProjection([agent('w1'), agent('w2', { clone_of: 'w1' })], []);
    expect(canvas.edges[0]!.kind).toBe('clone');
    expect(canvas.nodes[1]!.cloneOf).toBe('w1');
  });

  // Kullanıcının en baştan istediği görüntü: KİM KİME İŞ VERDİ.
  it('atama okunu issuerdan workera cizer', () => {
    const canvas = buildCanvasProjection(
      [agent('pm'), agent('w1')],
      [task('t1', { issuer_agent_id: 'pm', worker_agent_id: 'w1' })]);
    expect(canvas.edges).toEqual([expect.objectContaining({
      source: 'pm', target: 'w1', kind: 'assignment', taskId: 't1',
    })]);
  });

  // Biten iş hareketli görünürse tuval "hâlâ çalışıyor" yalanını söyler.
  it('yalnizca aktif gorevin oku animasyonludur', () => {
    const live = buildCanvasProjection([agent('pm'), agent('w1')],
      [task('t1', { issuer_agent_id: 'pm', worker_agent_id: 'w1', status: 'working' })]);
    const done = buildCanvasProjection([agent('pm'), agent('w1')],
      [task('t1', { issuer_agent_id: 'pm', worker_agent_id: 'w1', status: 'done' })]);

    expect(live.edges[0]!.animated).toBe(true);
    expect(done.edges[0]!.animated).toBe(false);
  });

  it('denetim oku yalnizca verifying durumunda animasyonludur', () => {
    const canvas = buildCanvasProjection([agent('w1'), agent('v1')],
      [task('t1', { worker_agent_id: 'w1', verifier_agent_id: 'v1', status: 'verifying' })]);
    const edge = canvas.edges.find((e) => e.kind === 'verification')!;
    expect(edge.animated).toBe(true);
  });

  // Bilinmeyen düğüme giden kenar tuvalde kopuk ok çizer.
  it('bilinmeyen agenta giden kenari atar', () => {
    const canvas = buildCanvasProjection([agent('w1')],
      [task('t1', { issuer_agent_id: 'yok', worker_agent_id: 'w1' })]);
    expect(canvas.edges).toEqual([]);
  });

  it('NIL alanlardan kenar uretmez', () => {
    expect(buildCanvasProjection([agent('w1')], [task('t1')]).edges).toEqual([]);
  });

  it('agentin kendine kenar cizmez', () => {
    const canvas = buildCanvasProjection([agent('w1')],
      [task('t1', { issuer_agent_id: 'w1', worker_agent_id: 'w1' })]);
    expect(canvas.edges).toEqual([]);
  });

  // Aynı kenarın iki kez çizilmesi tuvali okunmaz yapar.
  it('ayni kenari tekrarlamaz', () => {
    const canvas = buildCanvasProjection([agent('pm'), agent('w1')], [
      task('t1', { issuer_agent_id: 'pm', worker_agent_id: 'w1' }),
      task('t1', { issuer_agent_id: 'pm', worker_agent_id: 'w1' }),
    ]);
    expect(canvas.edges).toHaveLength(1);
  });
});

describe('buildCanvasProjection — canlılık', () => {
  const NIL2 = '00000000-0000-0000-0000-000000000000';
  const busy = {
    agent_id: 'w1', role: 'worker', group: 'coding', name: 'W', model_ref: 'm:1',
    parent_agent_id: NIL2, clone_of: NIL2, status: 'busy', current_task_id: NIL2,
  };

  // ASIL KUSUR: süreç ölünce satır 'busy' kalır ve tuval çalışmayan bir
  // agent'ı çalışıyor gösterir.
  it('heartbeati olmayan mesgul agenti yanit vermiyor isaretler', () => {
    const canvas = buildCanvasProjection([busy], [], new Set());
    expect(canvas.nodes[0]!.unresponsive).toBe(true);
  });

  it('heartbeati olan mesgul agenti isaretlemez', () => {
    const canvas = buildCanvasProjection([busy], [], new Set(['w1']));
    expect(canvas.nodes[0]!.unresponsive).toBe(false);
  });

  // Boşta agent'ın heartbeat'i zaten beklenmez; onu ölü göstermek yanlış alarm.
  it('bosta agenti yanit vermiyor saymaz', () => {
    const canvas = buildCanvasProjection([{ ...busy, status: 'idle' }], [], new Set());
    expect(canvas.nodes[0]!.unresponsive).toBe(false);
  });

  // Bilgi yoksa suçlamayız.
  it('canlilik bilgisi verilmediginde kimseyi isaretlemez', () => {
    expect(buildCanvasProjection([busy], []).nodes[0]!.unresponsive).toBe(false);
  });
});

describe('buildCanvasProjection — etkin model', () => {
  const NIL3 = '00000000-0000-0000-0000-000000000000';
  const worker = {
    agent_id: 'w1', role: 'worker', group: 'coding', name: 'W',
    model_ref: 'mock:worker', parent_agent_id: NIL3, clone_of: NIL3,
    status: 'idle', current_task_id: NIL3,
  };

  // ASIL KUSUR: canlı projede agent satırı `mock:worker` diyordu ama tüm
  // gerçek çağrılar `deepseek:deepseek-chat` ile yapılmıştı.
  it('rol eslemesindeki modeli gosterir', () => {
    const canvas = buildCanvasProjection([worker], [], undefined,
      (role) => (role === 'worker' ? 'deepseek:deepseek-chat' : undefined));
    expect(canvas.nodes[0]!.modelRef).toBe('deepseek:deepseek-chat');
  });

  // Eşleme yoksa agent'ın kendi modeli DOĞRUDUR: çağrı da onunla yapılır.
  it('esleme yoksa agentin kendi modeline duser', () => {
    const canvas = buildCanvasProjection([worker], [], undefined, () => undefined);
    expect(canvas.nodes[0]!.modelRef).toBe('mock:worker');
  });

  it('cozucu verilmezse eski davranisi korur', () => {
    expect(buildCanvasProjection([worker], []).nodes[0]!.modelRef).toBe('mock:worker');
  });
});

describe('buildCanvasProjection — B1/B2 yeni alanlar', () => {
  const NIL_B = '00000000-0000-0000-0000-000000000000';
  const mkAgent = (id: string, over: Record<string, unknown> = {}) => ({
    agent_id: id, role: 'worker', group: 'coding', name: `A${id}`,
    model_ref: 'ollama:qwen3.6:latest', parent_agent_id: NIL_B, clone_of: NIL_B,
    status: 'idle', current_task_id: NIL_B, ...over,
  });
  const mkTask = (id: string, title: string, over: Record<string, unknown> = {}) => ({
    task_id: id, title, status: 'working',
    issuer_agent_id: NIL_B, worker_agent_id: NIL_B, verifier_agent_id: NIL_B, ...over,
  });

  it('currentTaskTitle gorev basligini doldurur', () => {
    const canvas = buildCanvasProjection(
      [mkAgent('w1', { current_task_id: 't1' })],
      [mkTask('t1', 'CSS düzelt', { worker_agent_id: 'w1' })],
    );
    expect(canvas.nodes[0]!.currentTaskTitle).toBe('CSS düzelt');
  });

  it('gorev yoksa currentTaskTitle undefined', () => {
    const canvas = buildCanvasProjection([mkAgent('w1')], []);
    expect(canvas.nodes[0]!.currentTaskTitle).toBeUndefined();
  });

  it('elapsedSec status_changed_at yoksa undefined', () => {
    const canvas = buildCanvasProjection([mkAgent('w1')], []);
    expect(canvas.nodes[0]!.elapsedSec).toBeUndefined();
  });

  it('elapsedSec status_changed_at verilince hesaplanir', () => {
    // 10 dakika önce değişmiş
    const changedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const canvas = buildCanvasProjection(
      [mkAgent('w1', { status_changed_at: changedAt, status: 'waiting_answer' })],
      [],
      undefined, undefined,
    );
    const elapsed = canvas.nodes[0]!.elapsedSec;
    expect(elapsed).toBeGreaterThan(590); // 10 dk ~ 600 sn
  });

  it('stuckReason 5 dakika altinda undefined', () => {
    const changedAt = new Date(Date.now() - 4 * 60 * 1000).toISOString(); // 4 dk
    const canvas = buildCanvasProjection(
      [mkAgent('w1', { status: 'waiting_answer', status_changed_at: changedAt })],
      [],
    );
    expect(canvas.nodes[0]!.stuckReason).toBeUndefined();
  });

  it('stuckReason 5 dakika ustunde neden metni uretir', () => {
    const changedAt = new Date(Date.now() - 6 * 60 * 1000).toISOString(); // 6 dk
    const canvas = buildCanvasProjection(
      [mkAgent('w1', { status: 'waiting_answer', status_changed_at: changedAt })],
      [],
    );
    expect(canvas.nodes[0]!.stuckReason).toBe('cevap bekliyor');
  });

  it('atama okunda gorev basligini taskTitle olarak tasir', () => {
    const canvas = buildCanvasProjection(
      [mkAgent('pm', { role: 'pm' }), mkAgent('w1')],
      [mkTask('t1', 'Ana sayfa componenti', { issuer_agent_id: 'pm', worker_agent_id: 'w1' })],
    );
    const edge = canvas.edges.find((e) => e.kind === 'assignment')!;
    expect(edge.taskTitle).toBe('Ana sayfa componenti');
  });
});
