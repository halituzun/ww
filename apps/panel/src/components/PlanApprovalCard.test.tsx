/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { PlanApprovalCard } from "./PlanApprovalCard.js";
import type { Plan } from "../services/plans.js";

const sampleOrgPlan = {
  departments: [
    {
      id: "dept-ui",
      name: "Kullanıcı Arayüzü & Sunum",
      group: "design",
      lead_role: "group_lead",
      members: [
        { role: "worker", count: 2, model_tier: "light" },
        { role: "verifier", count: 1, model_tier: "light" },
      ],
      responsibility_patterns: ["index.html", "src/style.css"],
      rationale: "Kullanıcı etkileşimi ve arayüz sunumu",
    },
    {
      id: "dept-core",
      name: "Zamanlayıcı & Çekirdek Motor",
      group: "coding",
      lead_role: "group_lead",
      members: [
        { role: "worker", count: 1, model_tier: "heavy" },
        { role: "verifier", count: 1, model_tier: "medium" },
      ],
      responsibility_patterns: ["src/timer.js"],
      rationale: "Geri sayım döngüsü",
    },
  ],
  non_department_roles: [
    { role: "pm", reports_to: "user", rationale: "Koordinasyon" },
    { role: "interviewer", reports_to: "pm", rationale: "Görüşme" },
    { role: "standards_auditor", reports_to: "pm", rationale: "Denetim" },
  ],
  concurrency_limit: 2,
  estimated_tokens: 15000,
  estimated_cost_usd: 0.05,
};

const samplePlan: Plan = {
  plan_id: "plan-1",
  project_id: "prj-1",
  version: 1,
  plan_version: 1,
  status: "proposed",
  title: "Örnek Plan",
  content_md: "## Görevler\n1. Arayüz yap",
  team_json: {
    members: ["qwen3.6"],
    org_plan: sampleOrgPlan,
  },
  scenarios_json: { scenarios: [] },
  created_at: new Date().toISOString(),
};

describe("PlanApprovalCard", () => {
  afterEach(() => {
    cleanup();
  });
  it("başlık ve sürüm bilgilerini gösterir", () => {
    render(<PlanApprovalCard plan={samplePlan} />);
    expect(screen.getByText("Örnek Plan")).toBeDefined();
    expect(screen.getByText("Sürüm v1")).toBeDefined();
    expect(screen.getByText("Kullanıcı Onayı Bekliyor")).toBeDefined();
  });

  it("sekmeler arasında geçiş yapar ve organizasyon şemasını gösterir", () => {
    render(<PlanApprovalCard plan={samplePlan} />);

    // Başlangıçta görevler görünür
    expect(screen.getByText(/Arayüz yap/)).toBeDefined();

    // Organizasyon sekmesine tıkla
    const orgTab = screen.getByText(/Önerilen Organizasyon/);
    fireEvent.click(orgTab);

    // Departman isimleri ve detayları görünmeli
    expect(screen.getByText("Kullanıcı Arayüzü & Sunum")).toBeDefined();
    expect(screen.getByText("Zamanlayıcı & Çekirdek Motor")).toBeDefined();
    expect(screen.getByText(/Eşzamanlılık Sınırı:/)).toBeDefined();
    expect(screen.getByText(/Tahmini Bütçe:/)).toBeDefined();
  });

  it("ASLA ham İngilizce rol kimliği render etmez (Türkçe etiket denetimi)", () => {
    const { container } = render(<PlanApprovalCard plan={samplePlan} />);
    const orgTab = screen.getByText(/Önerilen Organizasyon/);
    fireEvent.click(orgTab);

    const renderedText = container.textContent || "";

    // Doğru Türkçe etiketler mevcut olmalı
    expect(renderedText).toContain("Grup lideri");
    expect(renderedText).toContain("yapan");
    expect(renderedText).toContain("denetleyen");
    expect(renderedText).toContain("Standart denetçisi");
    expect(renderedText).toContain("Görüşmeci");
    expect(renderedText).toContain("hafif katman");
    expect(renderedText).toContain("orta katman");
    expect(renderedText).toContain("ağır katman");
    expect(renderedText).toContain("kullanıcı");

    // Ham teknik kimlikler kesinlikle metin içinde geçmemeli
    expect(renderedText).not.toMatch(/Lider:\s*group_lead/);
    expect(renderedText).not.toMatch(/\d+\s+worker/);
    expect(renderedText).not.toMatch(/\d+\s+verifier/);
    expect(renderedText).not.toMatch(/standards_auditor/);
    expect(renderedText).not.toMatch(/→\s*user/);
    expect(renderedText).not.toMatch(/\(fast\)/);
    expect(renderedText).not.toMatch(/\(medium\)/);
    expect(renderedText).not.toMatch(/\(heavy\)/);
  });

  it("onayla butonuna basıldığında onApprove callback'ini tetikler", () => {
    const handleApprove = vi.fn();
    render(<PlanApprovalCard plan={samplePlan} onApprove={handleApprove} />);
    const approveBtn = screen.getByText("Planı ve Organizasyonu Onayla");
    fireEvent.click(approveBtn);
    expect(handleApprove).toHaveBeenCalledOnce();
  });

  it("revizyon iste butonuna basıldığında gerekçe formunu açar", () => {
    render(<PlanApprovalCard plan={samplePlan} />);
    const revBtn = screen.getByText("↻ Revizyon İste (Kadro / Görev Değiştir)");
    fireEvent.click(revBtn);
    expect(screen.getByPlaceholderText(/Gerekçe/)).toBeDefined();
    expect(screen.getByPlaceholderText(/özeti/)).toBeDefined();
  });
});
