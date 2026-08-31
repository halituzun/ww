import React from "react";
import { useCouncilTranscriptViewModel } from "../viewmodels/useCouncilTranscriptViewModel.js";
import type { CouncilEntry, CouncilRoundData } from "../services/council.js";
import type { OrgPlan } from "@ww/shared";

function getStoredPid(): string | null {
  try {
    return localStorage.getItem("active_project_id");
  } catch {
    return null;
  }
}

export type { CouncilEntry, CouncilRoundData } from "../services/council.js";

export interface DecisionRowData {
  readonly topic: string;
  readonly decision: "accepted" | "rejected" | "modified";
  readonly rationale: string;
  readonly dissent: string;
  readonly turn_number: number;
}

export function parseTranscriptFromMarkdown(contentMd: string): CouncilRoundData[] | undefined {
  if (!contentMd || !contentMd.includes("##")) return undefined;

  const rounds: CouncilRoundData[] = [];
  const dynamicMatches = [...contentMd.matchAll(/##\s+Tur\s+(\d+)\s*·\s*([^\n]+)\n([\s\S]*?)(?=\n##\s+|$)/giu)];
  if (dynamicMatches.length > 0) {
    for (const match of dynamicMatches) {
      const round = Number(match[1]);
      const title = (match[2] ?? "").trim();
      const sectionBody = (match[3] ?? "").trim();
      const speaker = /\*\*Konuşmacı:\*\*\s*([^\n]+)/u.exec(sectionBody)?.[1]?.trim() ?? "Konsey Üyesi";
      const model = /\*\*Model:\*\*\s*([^\n]+)/u.exec(sectionBody)?.[1]?.trim() ?? "bilinmiyor";
      const kind = /\*\*Tür:\*\*\s*([^\n]+)/u.exec(sectionBody)?.[1]?.trim() ?? "";
      const text = sectionBody
        .replace(/\*\*Konuşmacı:\*\*\s*[^\n]+\n?/u, "")
        .replace(/\*\*Model:\*\*\s*[^\n]+\n?/u, "")
        .replace(/\*\*Tür:\*\*\s*[^\n]+\n?/u, "")
        .trim();
      const isResearch = kind === "research" || title.toLowerCase().includes("araştırma");
      const isUncoordinated = /uzlaşılamadı|uzlasilamadi|uzlaşma sağlanamadı|aynı anda .*sağlanamaz|ayni anda .*saglanamaz|uncoordinated/iu.test(text);
      const stance: CouncilEntry["stance"] =
        kind === "objection" ? "objection"
          : kind === "draft_synthesis" ? "draft"
            : kind === "red_team" ? "red_team"
              : kind === "final_synthesis" ? "final"
                : kind === "research" ? "research"
                  : kind === "debate_round" ? "debate"
                    : "proposal";
      const roundData: CouncilRoundData = {
        round,
        title,
        badge: isResearch ? "Araştırma" : title.replace(/^.*?·\s*/u, "").split(" ")[0] || "Tur",
        summary: isResearch
          ? "Bilgi eksikliği nedeniyle araştırma turu açıldı."
          : "Konsey turu proje bağlamına göre kaydedildi.",
        entries: [{ speaker, role: speaker, model, stance, text }],
        isResearch,
        isUncoordinated,
      };
      rounds.push(stance === "final"
        ? { ...roundData, decision: "Nihai sentez bu turda kayda geçti." }
        : roundData);
    }
    return rounds.sort((a, b) => a.round - b.round);
  }

  const getSection = (titleKeyword: string) => {
    const match = contentMd.match(new RegExp(`## [^\\n]*${titleKeyword}[^\\n]*\\n([\\s\\S]*?)(?=(?:\\n## )|$)`, "i"));
    return match?.[1]?.trim() ?? "";
  };

  // Tur 1: Öneriler
  const propText = getSection("Öneri");
  if (propText) {
    const items = propText.split(new RegExp("(?:^|\\n)-\\s+\\*\\*")).filter(Boolean);
    const entries: CouncilEntry[] = items.map((item) => {
      const parts = item.replace(/^\\*\\*/, "").split(/\\*\\*:\\s*/);
      const speakerIndex = items.indexOf(item) + 1;
      const text = (parts.slice(1).join("**: ") || item).trim();
      return {
        speaker: `Üye ${speakerIndex}`,
        role: "Grup lideri",
        model: "ollama",
        stance: "proposal",
        text,
      };
    });
    rounds.push({
      round: 1,
      title: "Bağımsız Öneriler",
      badge: "Öneriler",
      summary: "Konsey üyeleri hedefe yönelik ilk bağımsız mimari tekliflerini sundu.",
      entries,
      decision: "İlk bağımsız öneriler toplandı, Tur 2 eleştiri ve itiraz aşamasına geçildi.",
    });
  }

  // Tur 2: İtirazlar
  const objText = getSection("İtiraz");
  if (objText) {
    const items = objText.split(new RegExp("(?:^|\\n)-\\s+\\*\\*")).filter(Boolean);
    const entries: CouncilEntry[] = items.map((item) => {
      const parts = item.replace(/^\\*\\*/, "").split(/\\*\\*:\\s*/);
      const speakerIndex2 = items.indexOf(item) + 1;
      const text = (parts.slice(1).join("**: ") || item).trim();
      return {
        speaker: `Üye ${speakerIndex2}`,
        role: "Denetçi",
        model: "ollama",
        stance: "objection",
        text,
      };
    });
    rounds.push({
      round: 2,
      title: "İtirazlar & Eleştiriler",
      badge: "İtirazlar",
      summary: "Önerilerdeki güvenlik riskleri, gereksiz şişkinlik ve çelişkiler masaya yatırıldı.",
      entries,
      decision: "İtirazlar kayda alındı, Tur 3 birleşik taslak için PM değerlendirmesine iletildi.",
    });
  }

  // Tur 3: Taslak
  const draftText = getSection("Taslak");
  if (draftText) {
    rounds.push({
      round: 3,
      title: "Birleşik Taslak Plan",
      badge: "Taslak",
      summary: "İtirazlar elenerek ilk uygulanabilir birleşik plan hazırlandı.",
      entries: [
        {
          speaker: "Proje Yöneticisi (PM)",
          role: "PM",
          model: "ollama:qwen3.6",
          stance: "draft",
          text: draftText,
        },
      ],
      decision: "Birleşik taslak oluşturuldu, Tur 4 Kırmızı Takım zafiyet testine gönderildi.",
    });
  }

  // Tur 4: Kırmızı Takım
  const redText = getSection("Kırmızı Takım") || getSection("Kirmizi Takim");
  if (redText) {
    rounds.push({
      round: 4,
      title: "Kırmızı Takım İncelemesi",
      badge: "Kırmızı Takım",
      summary: "Taslak plan kırılarak güvenlik açıkları, zafiyetler ve edge case'ler raporlandı.",
      entries: [
        {
          speaker: "Kırmızı Takım Lideri",
          role: "Kırmızı Takım",
          model: "ollama:deepseek-coder:33b",
          stance: "red_team",
          text: redText,
        },
      ],
      decision: "Zafiyet raporu mühürlendi; Tur 5 nihai karar için PM'e zorunlu girdi olarak iletildi.",
      dissent: "Regex sahte güvenlik sağlar, AST motoru zorunludur.",
    });
  }

  // Tur 5: Nihai Karar
  const synthText = getSection("Nihai Karar") || getSection("Karar") || getSection("Müzakere");
  if (synthText) {
    const kabulCount = (synthText.match(/KARAR:\\s*KABUL/gi) || []).length;
    const redCount = (synthText.match(/KARAR:\\s*RED/gi) || []).length;
    const parsedDecision = kabulCount > 0 
      ? `Kırmızı Takım bulguları değerlendirildi: ${kabulCount} KABUL, ${redCount} RED ile plan karara bağlandı.`
      : "Müzakere sonuçlandırıldı, mimari kararlar ve görevler mühürlendi.";

    const floatMatch = synthText.match(/BULGU\\s*2:[^\\n]*\\n(?:[\\s\\S]*?PLANA YANSIMASI:[^\\n]*)/i);
    const parsedDissent = floatMatch ? floatMatch[0].replace(/\\s+/g, " ").trim() : undefined;

    rounds.push({
      round: 5,
      title: "Nihai Karar & Şerhler",
      badge: "Nihai Karar",
      summary: "Müzakere tamamlandı; kesin mimari kararlar ve görevler mühürlendi.",
      entries: [
        {
          speaker: "Proje Yöneticisi (PM)",
          role: "PM",
          model: "ollama:qwen3.6",
          stance: "final",
          text: synthText,
        },
      ],
      decision: parsedDecision,
      dissent: parsedDissent,
    });
  }

  return rounds.length > 0 ? rounds : undefined;
}

export function CouncilTranscriptViewer({
  projectId,
  transcript: initialTranscript,
  planContentMd: initialPlanContentMd,
}: {
  readonly projectId?: string | undefined;
  readonly orgPlan?: OrgPlan | undefined;
  readonly transcript?: readonly CouncilRoundData[] | undefined;
  readonly planContentMd?: string | undefined;
}) {
  const targetPid = projectId ?? getStoredPid() ?? undefined;
  const {
    activeRound,
    selectRound,
    activeView,
    selectView,
    fetchedContentMd,
    decisions,
    additionalTopic,
    setAdditionalTopic,
    requestingRound,
    roundFeedback,
    submitRound,
  } = useCouncilTranscriptViewModel({
    projectId: targetPid,
    hasInitialContent: Boolean(initialPlanContentMd),
  });

  const handleRequestRound = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    await submitRound();
  };

  const effectiveMd = initialPlanContentMd || fetchedContentMd;
  const transcript = (initialTranscript && initialTranscript.length > 0) ? initialTranscript : (effectiveMd ? parseTranscriptFromMarkdown(effectiveMd) : undefined);

  if (!transcript || transcript.length === 0) {
    return (
      <div className="council-transcript-wrapper" style={{ background: "#0b111c", borderRadius: 12, border: "1px solid rgba(255,255,255,0.08)", padding: 24, textAlign: "center" }}>
        <h3 style={{ fontSize: "14px", color: "#f1f5f9", fontWeight: 600, margin: "0 0 8px 0" }}>
          Konsey Müzakeresi & Karar Defteri
        </h3>
        <p className="hint" style={{ fontSize: "12px", margin: 0 }}>
          Bu proje için henüz konsey müzakeresi çalıştırılmadı. Müzakere tamamlandığında dinamik turlar ve karar defteri burada listelenecektir.
        </p>
      </div>
    );
  }

  const current = transcript.find((r) => r.round === activeRound) || transcript[0]!;
  const isUncoordinated = transcript.some((r) => r.isUncoordinated);

  return (
    <div className="council-transcript-wrapper" style={{ background: "#0b111c", borderRadius: 12, border: "1px solid rgba(255,255,255,0.08)", padding: 20, display: "flex", flexDirection: "column", gap: "16px" }}>
      {/* Üst Başlık & Görünüm Değiştirici */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px" }}>
        <div>
          <h3 style={{ fontSize: "15px", color: "#f1f5f9", fontWeight: 600, margin: 0 }}>
            Konsey Müzakeresi & Karar Defteri (Faz H)
          </h3>
          <p className="hint" style={{ fontSize: "12px", margin: "4px 0 0 0" }}>
            Açık itirazlar sıfırlanana kadar devam eden dinamik müzakere ve mühürlü karar defteri.
          </p>
        </div>

        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <div className="canvas-tab-pills" style={{ display: "flex", gap: "4px", background: "rgba(15, 23, 42, 0.6)", padding: "3px", borderRadius: "8px" }}>
            <button
              type="button"
              className={`canvas-tab-pill ${activeView === "rounds" ? "active" : ""}`}
              style={{ fontSize: "11px", padding: "4px 10px" }}
              onClick={() => selectView("rounds")}
            >
              Müzakere Tutanakları ({transcript.length} Tur)
            </button>
            <button
              type="button"
              className={`canvas-tab-pill ${activeView === "decisions" ? "active" : ""}`}
              style={{ fontSize: "11px", padding: "4px 10px" }}
              onClick={() => selectView("decisions")}
            >
              Karar Defteri ({decisions.length > 0 ? decisions.length : 3})
            </button>
          </div>

          <span
            className="pill"
            style={{
              background: isUncoordinated ? "rgba(239, 68, 68, 0.15)" : "rgba(16, 185, 129, 0.15)",
              color: isUncoordinated ? "#ef4444" : "#10b981",
              border: isUncoordinated ? "1px solid rgba(239, 68, 68, 0.3)" : "1px solid rgba(16, 185, 129, 0.3)",
              fontSize: "11px",
              padding: "4px 8px",
            }}
          >
            {isUncoordinated ? "Uzlaşmazlık (9 Tur Sınırı)" : `Konsensüs: ${transcript.length} Tur Tamamlandı`}
          </span>
        </div>
      </div>

      {isUncoordinated && (
        <div style={{ background: "rgba(239, 68, 68, 0.1)", border: "1px solid rgba(239, 68, 68, 0.3)", borderRadius: 8, padding: "10px 14px", color: "#fca5a5", fontSize: "12px" }}>
          <strong>Uzlaşma Sağlanamadı (9 Tur Sınırı):</strong> Konsey üyeleri arasındaki zıt gereksinim çelişkisi 9 tur boyunca tam çözülemedi. Lütfen aşağıdaki formdan konseye odak noktası belirterek ek tur talep edin veya gereksinimleri sadeleştirin.
        </div>
      )}

      {activeView === "rounds" ? (
        <>
          {/* Tur Seçici Butonlar */}
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            {transcript.map((r) => {
              const isResearch = r.badge.toLowerCase().includes("araştırma") || r.isResearch;
              const isActive = activeRound === r.round;

              return (
                <button
                  key={r.round}
                  type="button"
                  style={{
                    padding: "6px 12px",
                    fontSize: "11px",
                    fontWeight: isActive ? 600 : 500,
                    color: isActive ? "#38bdf8" : (isResearch ? "#f59e0b" : "#94a3b8"),
                    backgroundColor: isActive ? "rgba(56, 189, 248, 0.15)" : "rgba(30, 41, 59, 0.5)",
                    border: isActive ? "1px solid #38bdf8" : (isResearch ? "1px solid rgba(245, 158, 11, 0.3)" : "1px solid rgba(148, 163, 184, 0.15)"),
                    borderRadius: 6,
                    cursor: "pointer",
                  }}
                  onClick={() => selectRound(r.round)}
                >
                  Tur {r.round}: {r.badge}
                </button>
              );
            })}
          </div>

          {/* Aktif Tur Detay Kartı */}
          <div style={{ background: "#0f172a", borderRadius: 10, border: "1px solid rgba(255,255,255,0.06)", padding: "16px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px", borderBottom: "1px solid rgba(255,255,255,0.06)", paddingBottom: "8px" }}>
              <h4 style={{ fontSize: "13px", color: "#38bdf8", margin: 0 }}>
                Tur {current.round}: {current.title}
              </h4>
              <span style={{ fontSize: "11px", color: "#94a3b8" }}>{current.summary}</span>
            </div>

            {/* Konuşmalar Listesi */}
            <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginBottom: "16px" }}>
              {current.entries.map((entry, idx) => {
                const isObjection = entry.stance === "objection";
                const isRedTeam = entry.stance === "red_team";
                const isFinal = entry.stance === "final";
                const isResearch = entry.stance === "research";
                const borderColor = isObjection ? "#ef4444" : (isRedTeam ? "#f59e0b" : (isResearch ? "#38bdf8" : (isFinal ? "#10b981" : "#38bdf8")));

                return (
                  <div
                    key={idx}
                    style={{
                      background: "rgba(30, 41, 59, 0.4)",
                      borderLeft: `3px solid ${borderColor}`,
                      borderRadius: "0 6px 6px 0",
                      padding: "10px 14px",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", color: "#94a3b8", marginBottom: "4px" }}>
                      <strong style={{ color: "#f1f5f9" }}>{entry.speaker}</strong>
                      <span>{entry.model}</span>
                    </div>
                    <div style={{ fontSize: "12px", color: "#cbd5e1", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
                      {entry.text}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Tur Kararı ve Şerh */}
            {current.decision && (
              <div style={{ background: "rgba(56, 189, 248, 0.08)", border: "1px solid rgba(56, 189, 248, 0.2)", borderRadius: 6, padding: "8px 12px", fontSize: "11px", color: "#38bdf8", marginBottom: current.dissent ? "8px" : "0" }}>
                <strong>Tur Kararı:</strong> {current.decision}
              </div>
            )}
            {current.dissent && (
              <div style={{ background: "rgba(245, 158, 11, 0.08)", border: "1px solid rgba(245, 158, 11, 0.2)", borderRadius: 6, padding: "8px 12px", fontSize: "11px", color: "#f59e0b" }}>
                <strong>Kayıtlı Şerh / Karşı Oy:</strong> {current.dissent}
              </div>
            )}
          </div>
        </>
      ) : (
        /* H3 — Karar Defteri Tablosu */
        <div style={{ background: "#0f172a", borderRadius: 10, border: "1px solid rgba(255,255,255,0.06)", padding: "16px", overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", color: "#cbd5e1" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.1)", textAlign: "left", color: "#94a3b8", fontSize: "11px" }}>
                <th style={{ padding: "8px" }}>Konu / Bulgu</th>
                <th style={{ padding: "8px" }}>Karar</th>
                <th style={{ padding: "8px" }}>Gerekçe</th>
                <th style={{ padding: "8px" }}>Şerh / Karşı Oy</th>
                <th style={{ padding: "8px", width: "50px" }}>Tur</th>
              </tr>
            </thead>
            <tbody>
              {decisions.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ padding: "14px 8px", color: "#94a3b8" }}>
                    Bu proje için karar defteri kaydı yok.
                  </td>
                </tr>
              ) : decisions.map((d, i) => (
                <tr key={i} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                  <td style={{ padding: "10px 8px", fontWeight: 500, color: "#f8fafc" }}>{d.topic}</td>
                  <td style={{ padding: "10px 8px" }}>
                    <span
                      style={{
                        padding: "2px 6px",
                        borderRadius: 4,
                        fontSize: "10px",
                        fontWeight: 600,
                        background: d.decision === "accepted" ? "rgba(16, 185, 129, 0.15)" : (d.decision === "rejected" ? "rgba(239, 68, 68, 0.15)" : "rgba(245, 158, 11, 0.15)"),
                        color: d.decision === "accepted" ? "#10b981" : (d.decision === "rejected" ? "#ef4444" : "#f59e0b"),
                      }}
                    >
                      {d.decision === "accepted" ? "KABUL" : (d.decision === "rejected" ? "RED" : "REVİZE")}
                    </span>
                  </td>
                  <td style={{ padding: "10px 8px", color: "#94a3b8" }}>{d.rationale}</td>
                  <td style={{ padding: "10px 8px", color: d.dissent ? "#f59e0b" : "#64748b" }}>{d.dissent || "—"}</td>
                  <td style={{ padding: "10px 8px", color: "#38bdf8", fontWeight: 600 }}>T{d.turn_number}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* H4 — Kullanıcı Kontrolü: Ek Müzakere Turu Talebi */}
      <div style={{ background: "rgba(15, 23, 42, 0.4)", borderRadius: 10, border: "1px solid rgba(148, 163, 184, 0.1)", padding: "14px" }}>
        <h4 style={{ fontSize: "12px", color: "#f1f5f9", fontWeight: 600, margin: "0 0 6px 0" }}>
          Müzakereyi Derinleştir (H4 · Ek Tur Talebi)
        </h4>
        <p style={{ fontSize: "11px", color: "#94a3b8", margin: "0 0 10px 0" }}>
          Müzakere sonucunu yetersiz buluyorsanız konsey üyelerinden belirli bir konuya odaklanarak ek bir tur tartışmalarını isteyebilirsiniz.
        </p>

        <form onSubmit={handleRequestRound} style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <input
            type="text"
            aria-label="Ek müzakere turu konusu"
            placeholder="Örn: Klavye kısayollarının erişilebilirlik ve performans etkisini tartışın..."
            value={additionalTopic}
            onChange={(e) => setAdditionalTopic(e.target.value)}
            disabled={requestingRound}
            style={{
              flex: 1,
              background: "rgba(30, 41, 59, 0.6)",
              border: "1px solid rgba(148, 163, 184, 0.2)",
              borderRadius: 6,
              padding: "8px 12px",
              fontSize: "12px",
              color: "#f8fafc",
            }}
          />
          <button
            type="submit"
            disabled={requestingRound || !additionalTopic.trim()}
            style={{
              background: "#0284c7",
              color: "#ffffff",
              border: "none",
              borderRadius: 6,
              padding: "8px 16px",
              fontSize: "12px",
              fontWeight: 600,
              cursor: requestingRound || !additionalTopic.trim() ? "not-allowed" : "pointer",
              opacity: requestingRound || !additionalTopic.trim() ? 0.6 : 1,
            }}
          >
            {requestingRound ? "Müzakere Başlatılıyor..." : "Ek Tur Talep Et"}
          </button>
        </form>

        {roundFeedback && (
          <div style={{ marginTop: "8px", fontSize: "11px", color: roundFeedback.startsWith("Hata") ? "#ef4444" : "#10b981" }}>
            {roundFeedback}
          </div>
        )}
      </div>
    </div>
  );
}
