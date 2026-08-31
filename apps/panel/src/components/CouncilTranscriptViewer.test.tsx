/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from "vitest";
import React from "react";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { CouncilTranscriptViewer, parseTranscriptFromMarkdown, type CouncilRoundData } from "./CouncilTranscriptViewer.js";

afterEach(() => {
  cleanup();
});

const mockRounds: CouncilRoundData[] = [
  {
    round: 1,
    title: "Bağımsız Öneriler",
    badge: "Öneriler",
    summary: "İlk öneriler",
    entries: [
      {
        speaker: "Proje Yöneticisi (PM)",
        role: "PM",
        model: "qwen3.6",
        stance: "proposal",
        text: "İlk öneri metni",
      },
    ],
    decision: "İlk karar",
  },
  {
    round: 2,
    title: "İtirazlar & Eleştiriler",
    badge: "İtirazlar",
    summary: "İtiraz özeti",
    entries: [
      {
        speaker: "Standart Denetçisi",
        role: "Denetçi",
        model: "qwen3.6",
        stance: "objection",
        text: "Somut İtiraz 1: Hata riski",
      },
    ],
    decision: "İtiraz kabul edildi",
  },
  {
    round: 5,
    title: "Nihai Karar & Şerhler",
    badge: "Nihai Karar",
    summary: "Sonuç",
    entries: [
      {
        speaker: "Proje Yöneticisi",
        role: "PM",
        model: "qwen3.6",
        stance: "final",
        text: "Mühürlendi",
      },
    ],
    decision: "Onaylandı",
    dissent: "Kayıtlı Şerh Metni",
  },
];

describe("CouncilTranscriptViewer (Faz H — Dinamik Tur ve Karar Defteri)", () => {
  it("veri yokken dürüstçe müzakere kaydı olmadığını gösterir (Mock uydurmaz)", () => {
    render(<CouncilTranscriptViewer transcript={undefined} />);

    expect(screen.getByText(/Konsey Müzakeresi & Karar Defteri/)).toBeDefined();
    expect(screen.getByText(/Bu proje için henüz konsey müzakeresi çalıştırılmadı/)).toBeDefined();
  });

  it("gerçek müzakere verisi sağlandığında turları, konuşmacıları ve şerhleri render eder", () => {
    render(<CouncilTranscriptViewer transcript={mockRounds} />);

    expect(screen.getByText(/Konsensüs: 3 Tur Tamamlandı/)).toBeDefined();
    expect(screen.getByText(/Tur 1: Öneriler/)).toBeDefined();
    expect(screen.getByText(/İlk öneri metni/)).toBeDefined();

    // Tur 2 ye geçiş
    fireEvent.click(screen.getByText(/Tur 2: İtirazlar/));
    expect(screen.getByText(/Somut İtiraz 1: Hata riski/)).toBeDefined();

    // Tur 5 ve Şerh kontrolü
    fireEvent.click(screen.getByText(/Tur 5: Nihai Karar/));
    expect(screen.getByText(/Kayıtlı Şerh \/ Karşı Oy:/)).toBeDefined();
    expect(screen.getByText(/Kayıtlı Şerh Metni/)).toBeDefined();

    // Karar Defteri görünümüne geçiş (Faz H3)
    fireEvent.click(screen.getByRole("button", { name: /Karar Defteri/ }));
    expect(screen.getByText(/Bu proje için karar defteri kaydı yok/)).toBeDefined();
    expect(screen.queryByText(/Regex tabanlı giriş filtrelemesi ve eval\(\) açığı/)).toBeNull();
  });

  it("dinamik araştırma turunu markdown planından ayrıştırır", () => {
    const rounds = parseTranscriptFromMarkdown(`# Plan

## Tur 5 · Araştırma ve Kod İncelemesi

**Konuşmacı:** Araştırma Lideri
**Model:** ollama:qwen3.6
**Tür:** research

Çevrimdışı mod ile canlı skor tablosu için teknik seçenekler araştırıldı.

## Tur 6 · Nihai Plan ve Kararlar

**Konuşmacı:** Proje Yöneticisi
**Model:** ollama:qwen3.6
**Tür:** final_synthesis

BULGU 1: Çevrimdışı çalışma ile canlı skor tablosu çelişkisi
KARAR: UZLAŞILAMADI
GEREKÇE: Aynı anda mutlak çevrimdışı ve gerçek zamanlı küresel skor sağlanamaz.
ÖNERİ: Kullanıcıdan seçenek alınacak.
`);

    expect(rounds).toHaveLength(2);
    expect(rounds?.[0]).toMatchObject({ round: 5, badge: "Araştırma", isResearch: true });
    expect(rounds?.[1]?.isUncoordinated).toBe(true);
  });
});
