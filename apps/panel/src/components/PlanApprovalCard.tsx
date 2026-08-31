import React from "react";
import type { Plan } from "../services/plans.js";
import { usePlanApprovalViewModel } from "../viewmodels/usePlanApprovalViewModel.js";
import { agentRoleLabel, modelTierLabel, reportsToLabel } from "../services/labels.js";
import type { OrgPlan } from "@ww/shared";

// Baş harfi büyük veya kısaltma formatı
function formatRoleName(role: string): string {
  if (role === "pm") return "PM";
  if (role === "interviewer") return "Görüşmeci";
  if (role === "standards_auditor") return "Standart denetçisi";
  if (role === "group_lead") return "Grup lideri";
  if (role === "worker") return "yapan";
  if (role === "verifier") return "denetleyen";
  return agentRoleLabel(role);
}

function formatTargetName(target: string): string {
  if (target === "user") return "kullanıcı";
  if (target === "pm") return "PM";
  if (target === "group_lead") return "grup lideri";
  return reportsToLabel(target);
}

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
  const { activeTab, setActiveTab } = vm;

  if (!plan) return null;

  const version = plan.plan_version ?? plan.version ?? 1;
  const isApproved = plan.status === "approved";
  const parsedTeam = typeof plan.team_json === "string"
    ? (() => { try { return JSON.parse(plan.team_json); } catch { return undefined; } })()
    : plan.team_json;
  const orgPlan = (parsedTeam as { org_plan?: OrgPlan } | undefined)?.org_plan;

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

        {/* Faz D3 & E: Görevler ve Organizasyon Sekmeleri (Emoji yok, tek primary kuralına uygun sekme stilleri) */}
        <div className="plan-tabs-toggle" role="tablist" aria-label="Plan bölümleri" style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "tasks"}
            className={`plan-tab-btn ${activeTab === "tasks" ? "plan-tab-btn--active" : ""}`}
            style={{
              padding: "6px 14px",
              fontSize: "12px",
              fontWeight: 500,
              borderRadius: "6px",
              border: activeTab === "tasks" ? "1px solid rgba(255,255,255,0.22)" : "1px solid rgba(255,255,255,0.06)",
              background: activeTab === "tasks" ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.02)",
              color: activeTab === "tasks" ? "#ffffff" : "#94a3b8",
              cursor: "pointer",
              transition: "all 0.15s ease",
            }}
            onClick={() => setActiveTab("tasks")}
          >
            Görevler ve Müzakere
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "org"}
            className={`plan-tab-btn ${activeTab === "org" ? "plan-tab-btn--active" : ""}`}
            style={{
              padding: "6px 14px",
              fontSize: "12px",
              fontWeight: 500,
              borderRadius: "6px",
              border: activeTab === "org" ? "1px solid rgba(255,255,255,0.22)" : "1px solid rgba(255,255,255,0.06)",
              background: activeTab === "org" ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.02)",
              color: activeTab === "org" ? "#ffffff" : "#94a3b8",
              cursor: "pointer",
              transition: "all 0.15s ease",
            }}
            onClick={() => setActiveTab("org")}
          >
            Önerilen Organizasyon {orgPlan ? `(${orgPlan.departments.length} Departman)` : ""}
          </button>
        </div>
      </div>

      <div className="plan-content-preview">
        {activeTab === "tasks" ? (
          <>
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
          </>
        ) : (
          <div className="plan-org-preview" style={{ padding: "12px 0" }}>
            {orgPlan ? (
              <div className="org-plan-details" style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                <div className="org-stats-bar" style={{ display: "flex", gap: "16px", background: "#0b111c", padding: "10px 14px", borderRadius: "8px", border: "1px solid rgba(255,255,255,0.08)" }}>
                  <div><strong>Departmanlar:</strong> {orgPlan.departments.length}</div>
                  <div><strong>Eşzamanlılık Sınırı:</strong> {orgPlan.concurrency_limit} LLM çağrısı</div>
                  <div><strong>Tahmini Bütçe:</strong> ~{orgPlan.estimated_tokens.toLocaleString()} token (${orgPlan.estimated_cost_usd})</div>
                </div>

                <div className="org-departments-list" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "12px" }}>
                  {orgPlan.departments.map((dept) => {
                    const totalMembers = dept.members.reduce((sum, m) => sum + m.count, 0);
                    return (
                      <div key={dept.id} className="org-dept-card" style={{ background: "#0f172a", border: "1px solid #334155", borderRadius: "8px", padding: "12px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                          <h4 style={{ margin: 0, color: "#38bdf8", fontSize: "14px" }}>{dept.name}</h4>
                          <span className="pill pill--mini">{totalMembers} üye</span>
                        </div>
                        <p style={{ fontSize: "12px", color: "#94a3b8", margin: "4px 0 8px 0" }}>{dept.rationale}</p>
                        <div style={{ fontSize: "11px", color: "#cbd5e1", display: "flex", flexDirection: "column", gap: "4px" }}>
                          <div><strong>Lider:</strong> {formatRoleName(dept.lead_role)}</div>
                          <div>
                            <strong>Üyeler:</strong>{" "}
                            {dept.members.map((m) => `${m.count} ${formatRoleName(m.role)} (${modelTierLabel(m.model_tier)})`).join(", ")}
                          </div>
                          <div><strong>Sorumluluk:</strong> <code style={{ color: "#10b981", fontSize: "10px" }}>{dept.responsibility_patterns.join(", ")}</code></div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {orgPlan.non_department_roles && orgPlan.non_department_roles.length > 0 ? (
                  <div className="org-non-dept-roles" style={{ fontSize: "12px", color: "#94a3b8", background: "#0b111c", padding: "8px 12px", borderRadius: "6px" }}>
                    <strong>Departman Dışı Roller:</strong>{" "}
                    {orgPlan.non_department_roles.map((r) => `${formatRoleName(r.role)} (→ ${formatTargetName(r.reports_to)})`).join(" · ")}
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="hint">Bu planda yapısal organizasyon şeması bulunmuyor (varsayılan kadro geçerli).</p>
            )}
          </div>
        )}
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
                {loading ? "Onaylanıyor…" : "Planı ve Organizasyonu Onayla"}
              </button>
              <button
                type="button"
                className="btn btn--secondary"
                onClick={vm.openRevision}
                disabled={loading}
              >
                ↻ Revizyon İste (Kadro / Görev Değiştir)
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
              <h4>Plan ve Organizasyon Revizyon Gerekçesi</h4>
              <p className="hint">Konseye ve PM'e iletilecek revizyon talimatı (Örn: "Test departmanını kaldır", "Arayüze +1 worker ekle"):</p>
              <input
                type="text"
                aria-label="Revizyon gerekçesi"
                placeholder="Gerekçe (Örn: Test departmanı gereksiz, arayüz odaklı ilerlensin)"
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
        <p className="hint plan-approved-hint">Bu plan ve organizasyon onaylandı, agent kadrosu kuruldu.</p>
      )}
    </div>
  );
}
