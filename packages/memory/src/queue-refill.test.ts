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
});
