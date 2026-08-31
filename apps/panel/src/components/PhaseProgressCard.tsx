// PhaseProgressCard — SALT GÖRÜNÜM (docs/09 MVVM standardı)
//
// ️  Faz ilerlemesi için ClickHouse'ta faz-bazlı bir tablo/alan YOKTUR.
// tasks.group = agent grubu (frontend/backend/qa), faz değil.
// plans.status = plan onay durumu (proposed/approved/superseded), faz değil.
// project.status = genel durum (draft/gathering/planning/running/completed), faz değil.
//
// Bu bileşen yalnızca dışarıdan enjekte edilmiş GERÇEK faz verisiyle render eder.
// Hiçbir prop yoksa → hiçbir şey çizmez.
//
// (2026-08-26) Kural ihlali düzeltildi: defaultPhases sabit listesi kaldırıldı.
// "faz ilerlemesi için veri kaynağı yok, kart çizilmedi" durumu test edildi.

import React from "react";

export interface PhaseItem {
  id: string;
  name: string;
  status: "done" | "active" | "waiting";
  detail?: string;
}

export function PhaseProgressCard({
  phases,
}: {
  readonly phases?: readonly PhaseItem[] | undefined;
}) {
  // Veri kaynağı yoksa kart çizilmez — "faz ilerlemesi için veri kaynağı yok"
  if (!phases || phases.length === 0) return null;

  const completedCount = phases.filter((p) => p.status === "done").length;
  const totalCount = phases.length;

  return (
    <div className="card phase-progress-card" role="region" aria-label="Faz ilerlemesi">
      <div className="phase-card-header">
        <div>
          <span className="eyebrow">AŞAMA DURUMU</span>
          <h3 className="phase-card-title">Faz İlerlemesi</h3>
        </div>
        <span className="phase-counter">
          {completedCount} / {totalCount} Tamamlandı
        </span>
      </div>

      <div className="phase-progress-bar">
        <div
          className="phase-progress-fill"
          style={{ width: `${Math.round((completedCount / totalCount) * 100)}%` }}
        />
      </div>

      <div className="phases-list">
        {phases.map((ph) => (
          <div key={ph.id} className={`phase-item phase-item--${ph.status}`}>
            <span className="phase-dot" aria-hidden="true" />
            <div className="phase-info">
              <strong className="phase-name">{ph.name}</strong>
              {ph.detail ? <small className="phase-detail">{ph.detail}</small> : null}
            </div>
            <span className={`pill pill--mini pill--phase-${ph.status}`}>
              {ph.status === "done" ? "Bitti" : ph.status === "active" ? "Çalışıyor" : "Bekliyor"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
