import { describe, expect, it, vi } from 'vitest';
import { createAndEnqueueSubtask, parseSubtaskInput } from './delegation.service.js';

const id = (n: number): string => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

describe('parseSubtaskInput', () => {
  it('geçerli girdiyi kabul eder', () => {
    expect(parseSubtaskInput({ title: 'alt iş', group: 'coding', budget: 1000 }))
      .toMatchObject({ title: 'alt iş', group: 'coding', budget: 1000 });
  });

  it('boş başlığı reddeder', () => {
    expect(() => parseSubtaskInput({ title: '  ', group: 'coding', budget: 1 })).toThrow();
  });

  // Bütçesiz alt görev, ebeveynin bütçe korumasını anlamsız kılar.
  it('bütçe zorunludur', () => {
    expect(() => parseSubtaskInput({ title: 'x', group: 'coding' })).toThrow();
  });

  it('negatif bütçeyi reddeder', () => {
    expect(() => parseSubtaskInput({ title: 'x', group: 'coding', budget: -1 })).toThrow();
  });

  it('bilinmeyen grubu reddeder', () => {
    expect(() => parseSubtaskInput({ title: 'x', group: 'uydurma', budget: 1 })).toThrow();
  });
});

describe('createAndEnqueueSubtask', () => {
  // ASIL KUSUR: servis yalnızca satırı yaratıyordu; kuyruğa girmeyen alt görev
  // 'queued' görünür ama hiçbir tüketici onu görmez.
  it('alt görevi yaratır ve kuyruğa koyar', async () => {
    const enqueue = vi.fn(async () => undefined);
    const task = await createAndEnqueueSubtask({
      createSubtask: async () => ({ task_id: id(2), project_id: id(1) }),
      enqueue,
    }, { title: 'x' });

    expect(task.task_id).toBe(id(2));
    expect(enqueue).toHaveBeenCalledWith(id(1), id(2));
  });

  // Yaratma başarısızsa kuyruğa hayalet görev girmemeli.
  it('yaratma düşerse kuyruğa koymaz', async () => {
    const enqueue = vi.fn(async () => undefined);
    await expect(createAndEnqueueSubtask({
      createSubtask: async () => { throw new Error('derinlik limiti'); },
      enqueue,
    }, {})).rejects.toThrow(/derinlik/);
    expect(enqueue).not.toHaveBeenCalled();
  });

  // Kuyruk hatası yutulursa görev sessizce hiç çalışmaz.
  it('kuyruk hatası yutulmaz', async () => {
    await expect(createAndEnqueueSubtask({
      createSubtask: async () => ({ task_id: id(2), project_id: id(1) }),
      enqueue: async () => { throw new Error('redis düştü'); },
    }, {})).rejects.toThrow(/redis/);
  });
});
