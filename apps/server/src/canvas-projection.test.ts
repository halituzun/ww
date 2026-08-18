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
