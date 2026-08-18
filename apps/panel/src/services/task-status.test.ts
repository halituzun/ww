import { describe, expect, it } from 'vitest';
import { TASK_STATUSES } from '@ww/shared';
import { taskStatusLabel } from './task-status.js';

describe('taskStatusLabel (karar K6: panel dili Türkçe)', () => {
  // KAPSAM KORUMASI: yeni bir durum eklenip etiketi yazılmazsa panel ham
  // İngilizce kimlik basar. Anlatıda aynı kusuru yaşadım; burada test
  // eklendiği turda yakalar.
  it('semadaki HER durum icin Turkce etiket vardir', () => {
    const missing = TASK_STATUSES.filter((status) => taskStatusLabel(status) === status);
    expect(missing).toEqual([]);
  });

  it('bilinen durumlari cevirir', () => {
    expect(taskStatusLabel('queued')).toBe('kuyrukta');
    expect(taskStatusLabel('waiting_user')).toBe('cevap bekliyor');
    expect(taskStatusLabel('done')).toBe('bitti');
  });

  // Bilinmeyen durum için ad KORUNUR, uydurulmaz: anlamadığı bir durumu
  // Türkçeleştirmek kullanıcıya olmayan bir anlam verir.
  it('bilinmeyen durumda ad korunur', () => {
    expect(taskStatusLabel('gelecekte_eklenecek')).toBe('gelecekte_eklenecek');
  });
});
