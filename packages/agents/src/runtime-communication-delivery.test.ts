import { describe, expect, it, vi } from 'vitest';
import type { EntityId } from '@ww/shared';
import { createRuntimeCommunicationDelivery } from './runtime-communication-delivery.js';

const id = (n: number): EntityId =>
  `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}` as EntityId;

const scope = {
  projectId: id(1),
  taskId: id(2),
  taskBriefId: id(3),
  assignmentAttemptId: id(4),
};

const auth = { type: 'internal_service', serviceName: 'ww-runtime' } as never;

const delivery = (send = vi.fn(async () => ({ messageId: id(99) }) as never)) => ({
  send,
  port: createRuntimeCommunicationDelivery({
    communication: { send } as never,
    authentication: auth,
    sessionId: id(10),
    owningPmId: id(11),
    now: () => '2026-08-17T09:00:00.000Z',
  }),
});

describe('createRuntimeCommunicationDelivery', () => {
  it('soruyu gerçek mesaj kanalına yazar ve mesaj kimliğini döner', async () => {
    const { send, port } = delivery();
    const result = await port.question({ ...scope, callId: id(5), text: 'hangi veritabanı?' });

    expect(result.messageId).toBe(id(99));
    const sent = send.mock.calls[0]![1] as never as Record<string, unknown>;
    expect(sent['kind']).toBe('question');
    expect(sent['payload']).toEqual({ type: 'question', text: 'hangi veritabanı?' });
    expect(sent['recipient']).toEqual({ type: 'agent', id: id(11) });
    expect(sent).toMatchObject(scope);
  });

  // Uydurulmuş kimlik dönmek, worker'a "soru iletildi" yalanı söyler.
  it('mesaj kimliğini kanalın döndüğü zarftan alır, kendi üretmez', async () => {
    const send = vi.fn(async () => ({ messageId: id(77) }) as never);
    const { port } = delivery(send);
    expect((await port.question({ ...scope, callId: id(5), text: 's' })).messageId).toBe(id(77));
  });

  // Aynı araç çağrısının tekrarı ikinci bir soru açmamalı.
  it('idempotency anahtarı çağrı kimliğine bağlıdır', async () => {
    const { send, port } = delivery();
    await port.question({ ...scope, callId: id(5), text: 's' });
    await port.question({ ...scope, callId: id(5), text: 's' });
    const [first, second] = send.mock.calls.map((call) => (call[1] as never as Record<string, unknown>)['idempotencyKey']);
    expect(first).toBe(second);
    expect(String(first)).toContain(id(5));
  });

  it('farklı çağrı kimliği farklı idempotency anahtarı üretir', async () => {
    const { send, port } = delivery();
    await port.question({ ...scope, callId: id(5), text: 's' });
    await port.question({ ...scope, callId: id(6), text: 's' });
    const [first, second] = send.mock.calls.map((call) => (call[1] as never as Record<string, unknown>)['idempotencyKey']);
    expect(first).not.toBe(second);
  });

  it('raporu görev kapsamıyla birlikte yazar', async () => {
    const { send, port } = delivery();
    await port.report('tahta bileşeni bitti', ['commit:abc'], {
      ...scope,
      invocationId: id(7),
      promptInputSnapshotId: id(8),
    });
    const sent = send.mock.calls[0]![1] as never as Record<string, unknown>;
    expect(sent['kind']).toBe('report');
    expect(sent['payload']).toEqual({
      type: 'report', summary: 'tahta bileşeni bitti', evidenceRefs: ['commit:abc'],
    });
    expect(sent).toMatchObject(scope);
  });

  // Rapor mühürlü girdiye bağlanmazsa "bu işi hangi çağrı üretti" izi kopar.
  it('rapor kaynağını mühürlü prompt anlık görüntüsüne bağlar', async () => {
    const { send, port } = delivery();
    await port.report('bitti', [], { ...scope, invocationId: id(7), promptInputSnapshotId: id(8) });
    const sent = send.mock.calls[0]![1] as never as Record<string, unknown>;
    expect(sent['invocationId']).toBe(id(7));
    expect(sent['promptInputSnapshotId']).toBe(id(8));
    expect(sent['provenance']).toMatchObject({ class: 'model_output' });
  });

  it('rapor idempotency anahtarı çağrıya bağlıdır', async () => {
    const { send, port } = delivery();
    await port.report('bitti', [], { ...scope, invocationId: id(7), promptInputSnapshotId: id(8) });
    await port.report('bitti', [], { ...scope, invocationId: id(7), promptInputSnapshotId: id(8) });
    const [first, second] = send.mock.calls.map((call) => (call[1] as never as Record<string, unknown>)['idempotencyKey']);
    expect(first).toBe(second);
  });

  // Kanal hatası yutulursa worker cevabı olmayan bir soruyu sonsuza dek bekler.
  it('kanal hatası yutulmaz', async () => {
    const send = vi.fn(async () => { throw new Error('clickhouse yazılamadı'); });
    const { port } = delivery(send as never);
    await expect(port.question({ ...scope, callId: id(5), text: 's' }))
      .rejects.toThrow(/clickhouse/);
  });

  it('internal_service olmayan kimlik doğrulamayı reddeder', () => {
    expect(() => createRuntimeCommunicationDelivery({
      communication: { send: vi.fn() } as never,
      authentication: { type: 'agent' } as never,
      sessionId: id(10),
      owningPmId: id(11),
      now: () => '2026-08-17T09:00:00.000Z',
    })).toThrow(/internal_service/);
  });
});
