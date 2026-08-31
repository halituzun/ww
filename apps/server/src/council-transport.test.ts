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

    // Faz D2 (5 Tur): 3 öneri + 3 itiraz + 1 birleşik taslak + 1 kırmızı takım + 1 nihai sentez = 9 mesaj
    expect(sent).toHaveLength(9);
    expect(sent.filter((turn) => turn.kind === 'proposal')).toHaveLength(3);
    expect(sent.filter((turn) => turn.kind === 'objection')).toHaveLength(3);
    expect(sent.filter((turn) => turn.kind === 'draft_synthesis')).toHaveLength(1);
    expect(sent.filter((turn) => turn.kind === 'red_team')).toHaveLength(1);
    expect(sent.filter((turn) => turn.kind === 'final_synthesis')).toHaveLength(1);
    expect(result.finalSynthesis.text).toBe('final_synthesis metni');
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

  // BOŞ TUR SÖZLEŞMESİ (Faz H).
  //
  // Bu test eskiden "boş turu reddeder ve taşımaya vermez" diyordu ve
  // KIRMIZIYDI: protokol Faz H'de bilerek değiştirilmişti — bir üyenin
  // susması tüm konseyi düşürmemeli. Üç ayrı politika yan yana duruyordu
  // (uygulama katmanı fırlatıyor, protokol [KATILMADI] yazıyor, test
  // reddedilmesini bekliyor). Sözleşme artık tek: bir kez yeniden dene,
  // ısrar ederse katılmama olarak KAYDET; ama hiç kimse konuşmazsa fırlat.
  it('bos donen uyeyi bir kez yeniden dener ve israr ederse [KATILMADI] olarak kaydeder', async () => {
    const send = vi.fn(async () => ({ messageId: 'm1' as never }));
    const protocol = new CouncilProtocol({ send });
    let calls = 0;

    const result = await protocol.run(
      { sessionId, members: [member(1), member(2), member(3)], prompt: 'hedef', maxCycles: 1 },
      async ({ kind, member: m }) => {
        calls += 1;
        // Yalnız 1 numaralı üye susuyor; diğerleri konuşuyor.
        const silent = String(m.agentId).endsWith('000000000001');
        return { text: silent ? '   ' : `${kind} gerekcesi` };
      },
    );

    const silentTurns = result.allTurns.filter((t) => t.text.startsWith('[KATILMADI]'));
    expect(silentTurns.length).toBeGreaterThan(0);
    // Susan üye için iki kez soruldu (ilk deneme + bir yeniden deneme).
    expect(calls).toBeGreaterThan(result.allTurns.length);
    // Kayıt yine de taşımaya verildi: konsey susan üyeyi YUTMAZ.
    expect(send).toHaveBeenCalled();
  });

  it('hicbir uye konusmazsa konseyi fail-closed dusurur', async () => {
    const send = vi.fn(async () => ({ messageId: 'm1' as never }));
    const protocol = new CouncilProtocol({ send });

    await expect(protocol.run(
      { sessionId, members: [member(1), member(2), member(3)], prompt: 'hedef', maxCycles: 1 },
      async () => ({ text: '   ' }),
    )).rejects.toThrow(/hicbir/i);
  });
});
