import { describe, expect, it, vi } from 'vitest';
import type { EntityId } from '@ww/shared';
import { isResumableStatus, resumeAnsweredTask } from './resume-answered-task.js';

const taskId = '00000000-0000-4000-8000-000000000001' as EntityId;

describe('resumeAnsweredTask', () => {
  // ASIL KUSUR: cevap yalnızca zamanlayıcı yarısını çağırıyordu; görev
  // 'working'e geçip atanmış kalıyor ama kimse YÜRÜTMÜYORDU.
  it('tam devam yaşam döngüsünü çalıştırır', async () => {
    const resume = vi.fn(async () => ({ status: 'done' }));
    expect(await resumeAnsweredTask(taskId, { resume })).toBe(true);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('sonuç durumunu bildirir', async () => {
    const onDone = vi.fn();
    await resumeAnsweredTask(taskId, { resume: async () => ({ status: 'escalated' }), onDone });
    expect(onDone).toHaveBeenCalledWith('escalated');
  });

  // Yaşam döngüsü HTTP cevabından ayrı koşar: buradan sızan hata yakalanmamış
  // promise reddi olur ve süreci düşürebilir. Cevap ise zaten yazılmıştır.
  it('yaşam döngüsü hatasını dışarı sızdırmaz', async () => {
    const result = await resumeAnsweredTask(taskId, {
      resume: async () => { throw new Error('model düştü'); },
    });
    expect(result).toBe(false);
  });

  // Yutulan hata görevi görünmez biçimde asar — canlı koşuda tam olarak
  // bu oldu: panel "çalışıyor" gösterdi, hiçbir şey ilerlemedi.
  it('hatayı bildirir', async () => {
    const onError = vi.fn();
    await resumeAnsweredTask(taskId, {
      resume: async () => { throw new Error('model düştü'); },
      onError,
    });
    expect(String(onError.mock.calls[0]![0])).toMatch(/model düştü/);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('hata durumunda sonuç bildirmez', async () => {
    const onDone = vi.fn();
    await resumeAnsweredTask(taskId, {
      resume: async () => { throw new Error('düştü'); },
      onDone,
      onError: () => undefined,
    });
    expect(onDone).not.toHaveBeenCalled();
  });
});

describe('isResumableStatus', () => {
  it('kullanıcı cevabı bekleyen durumları sürdürülebilir sayar', () => {
    expect(isResumableStatus('waiting_user')).toBe(true);
    expect(isResumableStatus('escalated')).toBe(true);
  });

  // Zaten çalışan bir görevi cevapla yeniden başlatmak onu İKİ KEZ koşturur;
  // biteni diriltmek tamamlanmış işi bozar.
  it('çalışan veya kapanmış görevi sürdürülebilir saymaz', () => {
    for (const status of ['working', 'queued', 'verifying', 'done', 'failed', 'cancelled']) {
      expect(isResumableStatus(status)).toBe(false);
    }
  });
});
