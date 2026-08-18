// Konsey taşımasının sözleşmesi.
//
// NEDEN VAR: konsey turları önce yalnızca BELLEKTE bir diziye toplanıyordu.
// Plan `council_session_id` ile oturuma bağlanıyor ama o oturumun hiçbir
// mesajı yoktu: "bu karar nasıl alındı" zinciri (plan → oturum → mesajlar)
// boşa çıkıyordu. Bu test taşımanın her turu KALICI yazdığını sabitler.
import { describe, expect, it, vi } from 'vitest';
import { CouncilService as CouncilProtocol } from '@ww/agents';

const member = (n: number) => ({
  agentId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` as never,
  modelRef: 'deepseek:deepseek-chat',
});

const sessionId = '00000000-0000-4000-8000-000000000099' as never;

describe('konsey taşıması', () => {
  it('her turu tasimaya verir ve mesaj kimligini geri alir', async () => {
    const sent: { kind: string; text: string }[] = [];
    const protocol = new CouncilProtocol({
      send: async (input) => {
        sent.push({ kind: input.kind, text: input.text });
        return { messageId: `m${sent.length}` as never };
      },
    });

    const result = await protocol.run(
      { sessionId, members: [member(1), member(2), member(3)], prompt: 'hedef', maxCycles: 1 },
      async ({ kind }) => ({ text: `${kind} metni` }),
    );

    // 3 öneri + 3 itiraz + 1 sentez
    expect(sent).toHaveLength(7);
    expect(sent.filter((turn) => turn.kind === 'proposal')).toHaveLength(3);
    expect(sent.filter((turn) => turn.kind === 'objection')).toHaveLength(3);
    expect(sent.filter((turn) => turn.kind === 'synthesis')).toHaveLength(1);
    expect(result.synthesis.text).toBe('synthesis metni');
  });

  // Yarısı kayıtlı bir tartışma, kaydı hiç olmayandan daha yanıltıcıdır:
  // taşıma düşerse konsey DURMALIDIR.
  it('tasima dustugunde konsey durur', async () => {
    const protocol = new CouncilProtocol({
      send: vi.fn(async () => { throw new Error('mesaj yazilamadi'); }),
    });

    await expect(protocol.run(
      { sessionId, members: [member(1), member(2), member(3)], prompt: 'hedef', maxCycles: 1 },
      async ({ kind }) => ({ text: `${kind} metni` }),
    )).rejects.toThrow(/mesaj yazilamadi/);
  });

  // Boş tur kaydedilirse tartışma okunamaz hâle gelir.
  it('bos turu reddeder ve tasimaya vermez', async () => {
    const send = vi.fn(async () => ({ messageId: 'm1' as never }));
    const protocol = new CouncilProtocol({ send });

    await expect(protocol.run(
      { sessionId, members: [member(1), member(2), member(3)], prompt: 'hedef', maxCycles: 1 },
      async () => ({ text: '   ' }),
    )).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});
