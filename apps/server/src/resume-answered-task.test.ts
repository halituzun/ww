import { describe, expect, it, vi } from 'vitest';
import type { EntityId } from '@ww/shared';
import { isResumableStatus, resumeAnsweredTask } from './resume-answered-task.js';

const taskId = '00000000-0000-4000-8000-000000000001' as EntityId;

const ports = (over: Partial<Parameters<typeof resumeAnsweredTask>[1]> = {}) => ({
  resume: vi.fn(async () => undefined),
  enqueue: vi.fn(async () => undefined),
  ...over,
});

describe('resumeAnsweredTask', () => {
  // ASIL KUSUR: cevap görevi 'working'e döndürüyor ama kuyruğa KOYMUYORDU.
  // Görev hiçbir tüketicinin görmediği bir durumda sonsuza dek asılı kalıyordu.
  it('sürdürdükten sonra görevi kuyruğa geri koyar', async () => {
    const p = ports();
    expect(await resumeAnsweredTask(taskId, p)).toBe(true);

    expect(p.resume).toHaveBeenCalledTimes(1);
    expect(p.enqueue).toHaveBeenCalledWith(taskId);
  });

  // Sıra önemlidir: kuyruğa önce koymak, henüz 'waiting_user' olan görevi
  // tüketiciye verir ve tüketici onu geçersiz durumda bulur.
  it('önce sürdürür, sonra kuyruğa koyar', async () => {
    const order: string[] = [];
    await resumeAnsweredTask(taskId, {
      resume: async () => { order.push('resume'); },
      enqueue: async () => { order.push('enqueue'); },
    });

    expect(order).toEqual(['resume', 'enqueue']);
  });

  // Sürdürme düşerse kuyruğa koymak, geçersiz durumdaki görevi tüketiciye verir.
  it('sürdürme hatasında kuyruğa KOYMAZ ve hatayı yutmaz', async () => {
    const enqueue = vi.fn(async () => undefined);
    await expect(resumeAnsweredTask(taskId, {
      resume: async () => { throw new Error('gecis reddedildi'); },
      enqueue,
    })).rejects.toThrow(/gecis reddedildi/);

    expect(enqueue).not.toHaveBeenCalled();
  });

  // Kuyruk hatası cevabı geçersiz kılmaz (kullanıcının yazdığı kaydedilmiştir),
  // ama sessiz kalmak görevi görünmez biçimde asardı.
  it('kuyruk hatasında patlamaz ama bildirir', async () => {
    const onError = vi.fn();
    const result = await resumeAnsweredTask(taskId, {
      resume: async () => undefined,
      enqueue: async () => { throw new Error('redis düştü'); },
      onError,
    });

    expect(result).toBe(false);
    expect(String(onError.mock.calls[0]![0])).toMatch(/redis düştü/);
  });
});

describe('isResumableStatus', () => {
  it('kullanıcı cevabı bekleyen durumları sürdürülebilir sayar', () => {
    expect(isResumableStatus('waiting_user')).toBe(true);
    expect(isResumableStatus('escalated')).toBe(true);
  });

  // Zaten çalışan bir görevi cevapla yeniden kuyruğa koymak onu İKİ KEZ
  // koşturur; biten görevi diriltmek ise tamamlanmış işi bozar.
  it('çalışan veya kapanmış görevi sürdürülebilir saymaz', () => {
    for (const status of ['working', 'queued', 'done', 'failed', 'cancelled']) {
      expect(isResumableStatus(status)).toBe(false);
    }
  });
});
