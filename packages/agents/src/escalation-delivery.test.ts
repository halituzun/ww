import { describe, expect, it, vi } from 'vitest';
import { CommunicationEscalationDelivery } from './escalation-delivery.js';
import type { PrincipalAuthentication } from './ports.js';

const AUTH: PrincipalAuthentication = {
  type: 'internal_service', credential: 'scheduler-token',
  issuedAt: '2026-08-18T09:00:00.000Z',
} as never;

const id = (n: number): string => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

const escalation = {
  projectId: id(1), sessionId: id(2), owningPmId: id(3),
  taskId: id(4), causationId: id(5),
  stableEffectId: 'effect-a', effectType: 'provider_invocation_v1',
  createdAt: '2026-08-18T09:00:00.000Z',
} as never;

const communication = (send = vi.fn(async () => ({ messageId: id(9) }))) =>
  ({ send } as never);

describe('CommunicationEscalationDelivery', () => {
  // docs/03 Tırmandırma Zinciri: "Her basamak `messages`'a escalation kaydı
  // + `events`'e escalation olayı yazar". Olay tarafı hiç yazılmıyordu;
  // denetim ucu bunu iki kaynağı birleştirerek örtmek zorunda kalmıştı.
  it('mesajin YANI SIRA escalation olayi da yazar', async () => {
    const send = vi.fn(async () => ({ messageId: id(9) }));
    const events: Record<string, unknown>[] = [];
    const delivery = new CommunicationEscalationDelivery(communication(send), AUTH, {
      appendEvent: async (row) => { events.push(row as Record<string, unknown>); },
    });

    await delivery.append(escalation);

    expect(send).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      project_id: id(1), task_id: id(4), event_type: 'escalation',
    });
    const payload = events[0]!['payload'] as { reason: string; evidenceRefs: string[] };
    expect(payload.reason).toBe('NON_REPLAY_SAFE_EFFECT_UNCERTAIN');
    expect(payload.evidenceRefs).toContain('effect:effect-a');
  });

  // Aynı tırmandırma iki kez teslim edilirse olay TEKİLLEŞMELİ: denetim
  // ekranı aynı olayı iki kez sayarsa "kaç fren tetiklendi" yanlış olur.
  it('ayni tirmandirma icin ayni event_idyi uretir', async () => {
    const events: Record<string, unknown>[] = [];
    const delivery = new CommunicationEscalationDelivery(communication(), AUTH, {
      appendEvent: async (row) => { events.push(row as Record<string, unknown>); },
    });

    await delivery.append(escalation);
    await delivery.append(escalation);

    expect(events[0]!['event_id']).toBe(events[1]!['event_id']);
    expect(String(events[0]!['event_id'])).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('farkli tirmandirmalar farkli event_id alir', async () => {
    const events: Record<string, unknown>[] = [];
    const delivery = new CommunicationEscalationDelivery(communication(), AUTH, {
      appendEvent: async (row) => { events.push(row as Record<string, unknown>); },
    });

    await delivery.append(escalation);
    await delivery.append({ ...(escalation as object), stableEffectId: 'effect-b' } as never);

    expect(events[0]!['event_id']).not.toBe(events[1]!['event_id']);
  });

  // Mesaj TESLİMATTIR, olay denetim izidir. Olay yazımı düşerse tırmandırma
  // düşmemeli: PM'e ulaşan uyarıyı, kaydı tutamadık diye iptal etmek
  // sorunu büyütür. Ama sessiz de kalmamalı.
  it('olay yazimi duserse tirmandirma yine de teslim edilir', async () => {
    const send = vi.fn(async () => ({ messageId: id(9) }));
    const seen: unknown[] = [];
    const delivery = new CommunicationEscalationDelivery(communication(send), AUTH, {
      appendEvent: async () => { throw new Error('clickhouse yok'); },
      onError: (reason) => { seen.push(reason); },
    });

    await expect(delivery.append(escalation)).resolves.toBeTruthy();
    expect(send).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(1);
  });

  it('olay portu verilmezse eski davranis korunur', async () => {
    const send = vi.fn(async () => ({ messageId: id(9) }));
    const delivery = new CommunicationEscalationDelivery(communication(send), AUTH);
    await expect(delivery.append(escalation)).resolves.toBeTruthy();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
