import { NIL_UUID } from '@ww/shared';
import { describe, expect, it } from 'vitest';
import { planQueueRefill } from './queue-refill.js';

describe('planQueueRefill', () => {
  // ASIL KUSUR: stream'de karşılığı olmayan 'queued' görev sonsuza dek bekler.
  it('stream’de olmayan görevi geri kuyruğa alır', () => {
    expect(planQueueRefill(['t1', 't2'], ['t1'])).toEqual(['t2']);
  });

  // Zaten kuyrukta olanı tekrar eklemek görevi iki kez çalıştırmayı dener.
  it('stream’de olanı tekrar eklemez', () => {
    expect(planQueueRefill(['t1'], ['t1'])).toEqual([]);
  });

  it('aynı görevi iki kez eklemez', () => {
    expect(planQueueRefill(['t1', 't1'], [])).toEqual(['t1']);
  });

  it('sırayı korur', () => {
    expect(planQueueRefill(['a', 'b', 'c'], ['b'])).toEqual(['a', 'c']);
  });

  it('boş kuyrukta hiçbir şey planlamaz', () => {
    expect(planQueueRefill([], ['t1'])).toEqual([]);
  });

  it('stream tamamen boşsa hepsini planlar', () => {
    expect(planQueueRefill(['a', 'b'], [])).toEqual(['a', 'b']);
  });

  // ÖLÇÜLDÜ (canlı ClickHouse, 2026-08-18): aynı görev kimlikleri kurtarma
  // taramasında 51 KEZ "onarıldı". Sebebi kuyruk değil, görevin kendisiydi:
  // `plan_id` NIL olan görev ATANAMAZ ("task plan kimligi tasimiyor"). Pompa
  // onu her seferinde reddediyor, teslim sınırı dolunca akıştan siliniyor,
  // kurtarma geri koyuyor — sonsuza dek.
  //
  // `attempt` bu döngüde 0'da kalır (ret ATAMADAN ÖNCE olur), bu yüzden
  // `max_attempts` freni hiç devreye girmez. Fren yoksa döngüyü kesen tek şey
  // buradaki yapısal kontroldür.
  describe('atanamaz görevler', () => {
    it('plansiz gorevi kuyruga geri KOYMAZ', () => {
      const plan = new Map([['t1', NIL_UUID], ['t2', 'aaaaaaaa-0000-4000-8000-000000000001']]);
      expect(planQueueRefill(['t1', 't2'], [], { planIdOf: (id) => plan.get(id) ?? '' }))
        .toEqual(['t2']);
    });

    it('bos plan kimligini de atanamaz sayar', () => {
      expect(planQueueRefill(['t1'], [], { planIdOf: () => '' })).toEqual([]);
    });

    it('plan bilgisi verilmezse eski davranis korunur', () => {
      expect(planQueueRefill(['t1', 't2'], [])).toEqual(['t1', 't2']);
    });
  });
});
