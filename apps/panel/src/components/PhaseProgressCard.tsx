import React from "react";
import type { Project } from "../services/projects.js";

export interface PhaseItem {
  id: string;
  name: string;
  status: "done" | "active" | "waiting";
  detail?: string;
}

export function PhaseProgressCard({
  project,
  customPhases,
}: {
  readonly project: Project | undefined;
  readonly customPhases?: readonly PhaseItem[] | undefined;
}) {
  if (!project) return null;

  const defaultPhases: PhaseItem[] = [
    {
      id: "req",
      name: "1. Gereksinim Analizi",
      status:
        project.status === "gathering"
          ? "active"
          : project.status === "draft"
          ? "waiting"
          : "done",
      detail: "Kullanıcı hedefleri ve isterler",
    },
    {
      id: "plan",
      name: "2. Mimari & Planlama",
      status:
        project.status === "planning"
          ? "active"
          : project.status === "gathering" || project.status === "draft"
          ? "waiting"
          : "done",
      detail: "Veritabanı, bileşen ve görev tasarımı",
    },
    {
      id: "dev",
      name: "3. Otonom Geliştirme",
      status:
        project.status === "running"
          ? "active"
          : project.status === "completed"
          ? "done"
          : "waiting",
      detail: "Agent ekibi görev icrası ve kod üretimi",
    },
    {
      id: "verify",
      name: "4. Doğrulama & Denetim",
      status:
        project.status === "completed"
          ? "done"
          : project.status === "running"
          ? "active"
          : "waiting",
      detail: "Testler, MVVM & güvenlik denetimleri",
    },
    {
      id: "deploy",
      name: "5. Dağıtım & Tamamlanma",
      status: project.status === "completed" ? "done" : "waiting",
      detail: "Çalışır canlı uygulama yayını",
    },
  ];

  const phases = customPhases ?? defaultPhases;
  const completedCount = phases.filter((p) => p.status === "done").length;
  const totalCount = phases.length;
  const activePhase = phases.find((p) => p.status === "active") ?? phases[0];

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
