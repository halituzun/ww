import { describe, expect, it } from 'vitest';
import { orderedEvents, replayAt } from './timeline-replay.js';

const event = (seq: number, name: string, data: unknown = {}) => ({
  event: name, seq, ts: `2026-08-18T00:00:${String(seq).padStart(2, '0')}.000Z`, data,
});

const stream = [
  event(1, 'task_created', { taskId: 't1' }),
  event(2, 'status_change', { taskId: 't1', status: 'working' }),
  event(3, 'status_change', { taskId: 't2', status: 'queued' }),
  event(4, 'status_change', { taskId: 't1', status: 'done' }),
];

describe('orderedEvents', () => {
  // Canlı akış sırasız gelebilir; sırasız oynatma yanlış bir geçmiş gösterir.
  it('olaylari seq sirasina koyar', () => {
    expect(orderedEvents([event(3, 'a'), event(1, 'b'), event(2, 'c')]).map((e) => e.seq))
      .toEqual([1, 2, 3]);
  });
});

describe('replayAt', () => {
  it('kaydiricinin durdugu ana kadarki olaylari gosterir', () => {
    expect(replayAt(stream, 2).visible.map((e) => e.seq)).toEqual([1, 2]);
  });

  // ASIL KUSUR: geçmişe dönmek mümkün değildi; tuval hep şimdiki durumu
  // çiziyordu.
  it('o andaki gorev durumlarini turetir', () => {
    const state = replayAt(stream, 3);
    expect(state.statusByTask.get('t1')).toBe('working');
    expect(state.statusByTask.get('t2')).toBe('queued');
  });

  it('sonraki degisikligi gecmise yansitmaz', () => {
    expect(replayAt(stream, 2).statusByTask.get('t1')).toBe('working');
    expect(replayAt(stream, 4).statusByTask.get('t1')).toBe('done');
  });

  // Olayı olmayan görevin geçmişteki durumu BİLİNMEZ; şimdiki durumu geçmişe
  // yazmak olmayan bir geçmiş uydurmak olurdu.
  it('olayi olmayan gorevin durumunu uydurmaz', () => {
    expect(replayAt(stream, 2).statusByTask.has('t2')).toBe(false);
  });

  it('kaydirici basta hicbir sey gostermez', () => {
    const state = replayAt(stream, 0);
    expect(state.visible).toHaveLength(0);
    expect(state.at).toBeUndefined();
  });

  it('kaydirici sonda tum olaylari gosterir', () => {
    expect(replayAt(stream, 99).visible).toHaveLength(4);
  });

  it('gecersiz kaydirici degerinde sona duser', () => {
    expect(replayAt(stream, Number.NaN).visible).toHaveLength(4);
  });

  it('durdugu olayi bildirir', () => {
    expect(replayAt(stream, 3).at?.seq).toBe(3);
  });

  it('bos akista bos durum doner', () => {
    const state = replayAt([], 5);
    expect(state.visible).toHaveLength(0);
    expect(state.statusByTask.size).toBe(0);
  });
});
