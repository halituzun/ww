import React from "react";
import type { Plan } from "../services/plans.js";
import { usePlanApprovalViewModel } from "../viewmodels/usePlanApprovalViewModel.js";

export function PlanApprovalCard({
  plan,
  onApprove,
  onReject,
  onReplan,
  loading = false,
}: {
  readonly plan: Plan | undefined;
  readonly onApprove?: (() => Promise<void> | void) | undefined;
  readonly onReject?: ((note: string) => Promise<void> | void) | undefined;
  readonly onReplan?: ((reason: string, summary: string) => Promise<void> | void) | undefined;
  readonly loading?: boolean | undefined;
}) {
  const vm = usePlanApprovalViewModel({ onReplan });

  if (!plan) return null;

  const version = plan.plan_version ?? plan.version ?? 1;
  const isApproved = plan.status === "approved";

  return (
    <div className="card plan-approval-card" role="region" aria-label="Plan onay kartı">
      <div className="plan-card-header">
        <div className="plan-title-group">
          <div className="plan-badges">
            <span className="pill pill--mini">Sürüm v{version}</span>
            <span className={`pill ${isApproved ? "pill--done" : "pill--warning"}`}>
              {isApproved ? "Onaylandı" : "Kullanıcı Onayı Bekliyor"}
            </span>
          </div>
          <h3 className="plan-title">{plan.title || "Proje Mimari ve Görev Planı"}</h3>
        </div>
      </div>

      <div className="plan-content-preview">
        <div className={`plan-markdown ${vm.showFullContent ? "plan-markdown--full" : ""}`}>
          {plan.content_md ? (
            <pre className="plan-text">{plan.content_md}</pre>
          ) : (
            <p className="hint">Plan detayı henüz hazır değil veya oluşturuluyor…</p>
          )}
        </div>
        {plan.content_md && plan.content_md.length > 300 ? (
          <button
            type="button"
            className="linklike plan-toggle-btn"
            onClick={vm.toggleContent}
          >
            {vm.showFullContent ? "Daha az göster ↑" : "Tüm planı göster ↓"}
          </button>
        ) : null}
      </div>

      {!isApproved ? (
        <div className="plan-actions">
          {!vm.showRevisionInput ? (
            <div className="plan-buttons">
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => void onApprove?.()}
                disabled={loading}
              >
                {loading ? "Onaylanıyor…" : "✓ Planı Onayla ve Başlat"}
              </button>
              <button
                type="button"
                className="btn btn--secondary"
                onClick={vm.openRevision}
                disabled={loading}
              >
                ↻ Revizyon İste
              </button>
            </div>
          ) : (
            <form
              className="plan-revision-form"
              onSubmit={(e) => {
                e.preventDefault();
                void vm.submitRevision();
              }}
            >
              <h4>Plan Revizyon Gerekçesi</h4>
              <p className="hint">PM agent planı bu gerekçelere göre baştan düzenleyecektir:</p>
              <input
                type="text"
                aria-label="Revizyon gerekçesi"
                placeholder="Gerekçe (Örn: Ödeme altyapısı Stripe yerine iyzico olmalı)"
                value={vm.revisionReason}
                onChange={(e) => vm.setRevisionReason(e.target.value)}
                required
              />
              <textarea
                aria-label="İstenen değişiklikler özeti"
                placeholder="İstenen değişikliklerin özeti..."
                value={vm.revisionSummary}
                onChange={(e) => vm.setRevisionSummary(e.target.value)}
                rows={2}
                required
              />
              <div className="plan-form-buttons">
                <button type="submit" className="btn btn--primary" disabled={loading}>
                  {loading ? "Gönderiliyor…" : "Revizyonu Gönder"}
                </button>
                <button
                  type="button"
                  className="btn btn--secondary"
                  onClick={vm.closeRevision}
                >
                  Vazgeç
                </button>
              </div>
            </form>
          )}
        </div>
      ) : (
        <p className="hint plan-approved-hint">✓ Bu plan onaylandı ve görevler oluşturulup yürütmeye alındı.</p>
      )}
    </div>
  );
}
