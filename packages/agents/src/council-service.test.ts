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
