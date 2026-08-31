import { describe, it, expect, vi } from "vitest";
import { CouncilService, checkConvergence, extractDecisionsFromText } from "./council-service.js";
import { randomUUID } from "node:crypto";
import type { EntityId } from "@ww/shared";

describe("CouncilService (Faz H — Müzakere Derinliği & Dinamik Tur)", () => {
  const members = [
    { agentId: randomUUID() as EntityId, modelRef: "test-model-1", role: "chair" },
    { agentId: randomUUID() as EntityId, modelRef: "test-model-2", role: "red_team" },
    { agentId: randomUUID() as EntityId, modelRef: "test-model-3", role: "researcher" },
  ];

  it("H1: Açık itiraz veya çelişki yoksa 5 turda yakınsar ve kararları çıkarır", async () => {
    const transport = { send: vi.fn().mockResolvedValue({ messageId: "m-1" }) };
    const service = new CouncilService(transport);

    const result = await service.run(
      {
        sessionId: randomUUID() as EntityId,
        members,
        prompt: "Basit hesap makinesi",
      },
      async ({ kind, turnNumber }) => {
        if (kind === "final_synthesis") {
          return {
            text: `Bulgu: Regex tabanli eval filtreleme guvenligi\nKarar: KABUL\nGerekce: AST tabanli guvenli motor sart.\n\nBulgu: Float yuvarlama\nKarar: KABUL\nGerekce: Tamsayi olcekleme uygulanacak.`,
          };
        }
        return { text: `Tur ${turnNumber} yaniti` };
      }
    );

    expect(result.converged).toBe(true);
    expect(result.status).toBe("converged");
    expect(result.totalRounds).toBe(5);
    expect(result.decisions).toHaveLength(2);
    expect(result.decisions[0].topic).toContain("eval filtreleme");
    expect(result.decisions[0].decision).toBe("accepted");
  });

  it("H2: Bilgi eksikliği olduğunda araştırma turu açar ve devam eder", async () => {
    const transport = { send: vi.fn().mockResolvedValue({ messageId: "m-1" }) };
    const service = new CouncilService(transport);

    let finalSynthesisCallCount = 0;

    const result = await service.run(
      {
        sessionId: randomUUID() as EntityId,
        members,
        prompt: "Kütüphane uyumluluğu belirsiz proje",
        maxTurns: 9,
      },
      async ({ kind, turnNumber }) => {
        if (kind === "proposal" && turnNumber === 1) {
          return {
            text: "WebAudio API desteği belirsiz; araştırılmalı.",
          };
        }
        if (kind === "final_synthesis") {
          finalSynthesisCallCount += 1;
          return {
            text: `Tur ${turnNumber}: Araştırma tamamlandı, WebAudio yerine basit synth kararlaştırıldı.\nBulgu: Ses motoru\nKarar: KABUL\nGerekçe: Araştırma bulgusuyla uyumlu synth motoru.`,
          };
        }
        if (kind === "research") {
          return {
            text: `Tur ${turnNumber} Araştırmacı: Kod tabanında WebAudio desteği yok, dahili AudioContext kullanılabilir.`,
          };
        }
        return { text: `Tur ${turnNumber} yaniti` };
      }
    );

    expect(result.allTurns.some((t) => t.kind === "research")).toBe(true);
    expect(result.totalRounds).toBe(6); // Tur 5 araştırma + Tur 6 nihai sentez
    expect(result.converged).toBe(true);
    expect(finalSynthesisCallCount).toBe(1);
  });

  it("H1: Kasten çözülemeyen çelişkide 9. tura kadar devam edip uncoordinated damgası vurur", async () => {
    const transport = { send: vi.fn().mockResolvedValue({ messageId: "m-1" }) };
    const service = new CouncilService(transport);

    const result = await service.run(
      {
        sessionId: randomUUID() as EntityId,
        members,
        prompt: "Hem tamamen çevrimdışı çalışsın hem canlı küresel çok oyunculu skor tablosu olsun",
        maxTurns: 9,
      },
      async ({ kind, turnNumber }) => {
        if (kind === "final_synthesis") {
          return {
            text: `Tur ${turnNumber}: Gereksinimler arasında açık çelişki tespit edildi: cevrimdisi calisma ve canli skor tablosu ayni anda saglanamaz.`,
          };
        }
        if (kind === "debate_round") {
          return {
            text: `Tur ${turnNumber}: Kırmızı takım itirazı sürdürüyor, uzlaşmazlık devam ediyor.`,
          };
        }
        return { text: `Tur ${turnNumber} yaniti` };
      }
    );

    expect(result.totalRounds).toBe(9);
    expect(result.converged).toBe(false);
    expect(result.status).toBe("uncoordinated");
  });

  it("H3: UZLAŞILAMADI kararını kabul edilmiş karar gibi yazmaz", () => {
    const decisions = extractDecisionsFromText(`BULGU 1: Çevrimdışı çalışma ile canlı skor çelişkisi
KARAR: UZLAŞILAMADI
GEREKÇE: Aynı anda mutlak çevrimdışı ve gerçek zamanlı küresel skor sağlanamaz.
ÖNERİ: Kullanıcıdan kapsam tercihi alınacak.`, 8);

    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.decision).toBe("rejected");
    expect(decisions[0]?.rationale).not.toContain("GEREKÇE:");
  });
});

// H1 yakınsama ölçümü. NEDEN BU TESTLER: checkConvergence bu dosyada
// import EDİLİYORDU ama hiç çağrılmıyordu — konseyin "durabilir miyim"
// kararını veren mantığın sıfır testi vardı ve lint bunu yalnız
// "kullanılmayan import" olarak gösteriyordu.
describe("checkConvergence (H1)", () => {
  const turn = (
    kind: Parameters<typeof checkConvergence>[0][number]["kind"],
    text: string,
    turnNumber = 1,
  ) => ({
    memberId: randomUUID() as EntityId,
    kind,
    turnNumber,
    turnTitle: `Tur ${turnNumber}`,
    text,
    evidenceRefs: [] as readonly string[],
  });

  it("nihai sentez yokken yakınsamaz", () => {
    const result = checkConvergence([turn("proposal", "Basit bir plan önerisi.")], 1);
    expect(result.converged).toBe(false);
    expect(result.unresolvedCount).toBeGreaterThan(0);
    expect(result.reasons.join(" ")).toContain("Nihai sentez");
  });

  it("itirazsız ve temiz nihai sentezde yakınsar", () => {
    const result = checkConvergence(
      [
        turn("proposal", "Tetris oyunu icin plan.", 1),
        turn("final_synthesis", "Plan kabul edildi ve tum maddeler karara baglandi.", 2),
      ],
      2,
    );
    expect(result.converged).toBe(true);
    expect(result.openObjectionCount).toBe(0);
    expect(result.needsResearch).toBe(false);
  });

  it("nihai turda ele alınmayan itirazı açık sayar", () => {
    const result = checkConvergence(
      [
        turn("objection", "Ciddi bir güvenlik zafiyeti var.", 1),
        turn("final_synthesis", "Renk paleti ve yerlesim onaylandi.", 2),
      ],
      2,
    );
    expect(result.openObjectionCount).toBe(1);
    expect(result.converged).toBe(false);
  });

  it("bilgi eksikliği araştırma turu ister, araştırma yapılınca istemez", () => {
    const withGap = [
      turn("proposal", "Kutuphane destegi belirsiz, arastirma gerekiyor.", 1),
      turn("final_synthesis", "Plan tamam.", 2),
    ];
    expect(checkConvergence(withGap, 2).needsResearch).toBe(true);

    const afterResearch = [
      withGap[0]!,
      turn("research", "Kutuphane uyumlu, dogrulandi.", 2),
      turn("final_synthesis", "Plan tamam.", 3),
    ];
    const done = checkConvergence(afterResearch, 3);
    expect(done.needsResearch).toBe(false);
    // splice(-1,1) korumasi: arastirma gerekcesi yokken son gerekce SİLİNMEZ.
    expect(done.reasons).not.toContain(undefined);
  });

  it("brief'teki çevrimdışı/canlı çelişkisi açıkça karara bağlanmazsa çelişki sayar", () => {
    const result = checkConvergence(
      [turn("final_synthesis", "Oyun tarayicida calisir.", 1)],
      1,
      "Cevrimdisi calisan ve canli skor tablosu olan bir oyun",
    );
    expect(result.contradictionCount).toBeGreaterThan(0);
    expect(result.converged).toBe(false);
  });
});
