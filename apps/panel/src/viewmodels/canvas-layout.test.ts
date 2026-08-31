import { describe, it, expect } from "vitest";
import { computeOrgLayout, cleanRoleTitle } from "./canvas-layout.js";
import { formatElapsed } from "../services/labels.js";
import type { CanvasNode } from "./canvas-edges.js";
import type { OrgPlan } from "@ww/shared";

const sampleNodes: readonly CanvasNode[] = [
  { id: "agent-pm", label: "PM Agent", role: "pm", status: "busy", modelRef: "ollama:qwen3.6", elapsedSec: 120 },
  { id: "agent-interviewer", label: "Görüşmeci", role: "interviewer", status: "idle", modelRef: "ollama:qwen3.6", elapsedSec: 40 },
  { id: "agent-auditor", label: "Denetçi", role: "standards_auditor", status: "idle", modelRef: "ollama:qwen3.6", elapsedSec: 40 },
  { id: "agent-worker-1", label: "UI Worker", role: "worker", status: "busy", modelRef: "ollama:deepseek-33b", elapsedSec: 80 },
  { id: "agent-verifier-1", label: "UI Verifier", role: "verifier", status: "idle", modelRef: "ollama:qwen3.6", elapsedSec: 30 },
  { id: "agent-worker-2", label: "Core Worker", role: "worker", status: "busy", modelRef: "ollama:mistral-large", elapsedSec: 80 },
  { id: "agent-verifier-2", label: "Core Verifier", role: "verifier", status: "idle", modelRef: "ollama:qwen3.6", elapsedSec: 30 },
];

const sampleOrgPlan: OrgPlan = {
  departments: [
    {
      id: "dept-ui",
      name: "Kullanıcı Arayüzü & Sunum",
      group: "design",
      lead_role: "group_lead",
      members: [
        { role: "worker", count: 1, model_tier: "light" },
        { role: "verifier", count: 1, model_tier: "light" },
      ],
      responsibility_patterns: ["src/views/**", "src/styles/**"],
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

describe("canvas-layout (Faz E: Nizami Organizasyon Tuvali)", () => {
  it("DETERMİNİSTİK: Aynı org planı ve düğümler iki kez hesaplandığında BİREBİR AYNI koordinatları üretir", () => {
    const layout1 = computeOrgLayout(sampleNodes, sampleOrgPlan);
    const layout2 = computeOrgLayout(sampleNodes, sampleOrgPlan);

    expect(layout1.groupNodes.length).toBe(layout2.groupNodes.length);
    expect(layout1.edges.length).toBe(layout2.edges.length);
    expect(layout1.augmentedNodes.length).toBe(layout2.augmentedNodes.length);

    layout1.augmentedNodes.forEach((node) => {
      const pos1 = layout1.nodePositions.get(node.id);
      const pos2 = layout2.nodePositions.get(node.id);
      expect(pos1).toBeDefined();
      expect(pos2).toBeDefined();
      expect(pos1?.x).toBe(pos2?.x);
      expect(pos1?.y).toBe(pos2?.y);
    });

    layout1.groupNodes.forEach((grp, idx) => {
      const grp2 = layout2.groupNodes[idx];
      expect(grp.id).toBe(grp2?.id);
      expect(grp.position.x).toBe(grp2?.position.x);
      expect(grp.position.y).toBe(grp2?.position.y);
      expect(grp.style.width).toBe(grp2?.style.width);
      expect(grp.style.height).toBe(grp2?.style.height);
    });
  });

  it("GRUP LİDERLERİ: Her departman çerçevesinde lider düğümü bulunur ve PM'den liderlere hiyerarşi oku iner", () => {
    const layout = computeOrgLayout(sampleNodes, sampleOrgPlan);

    // Her departman için bir lider düğümü olmalı
    const leadNodes = layout.augmentedNodes.filter((n) => n.role === "group_lead");
    expect(leadNodes.length).toBe(2);

    // PM'den her iki lidere hiyerarşi oku inmelidir
    leadNodes.forEach((lead) => {
      const edge = layout.edges.find((e) => e.source === "agent-pm" && e.target === lead.id && e.kind === "hierarchy");
      expect(edge).toBeDefined();
    });
  });

  it("HİYERARŞİ VE YERLEŞİM: PM en üstte ortada (y:40), Görüşmeci sol kanatta, departmanlar altta", () => {
    const layout = computeOrgLayout(sampleNodes, sampleOrgPlan);

    const pmPos = layout.nodePositions.get("agent-pm");
    const interviewerPos = layout.nodePositions.get("agent-interviewer");
    const auditorPos = layout.nodePositions.get("agent-auditor");

    expect(pmPos).toBeDefined();
    expect(interviewerPos).toBeDefined();
    expect(auditorPos).toBeDefined();

    expect(pmPos!.y).toBe(40);
    expect(interviewerPos!.x).toBeLessThan(pmPos!.x);
    expect(auditorPos!.x).toBeGreaterThan(pmPos!.x);

    // Çerçeveler yan yana
    expect(layout.groupNodes.length).toBe(2);
    expect(layout.groupNodes[0]!.position.y).toBe(200);
    expect(layout.groupNodes[1]!.position.x).toBeGreaterThan(layout.groupNodes[0]!.position.x);
  });

  it("SÜRE BİÇİMİ (formatElapsed): 60 saniye altı, dakika ve saat birimleri doğru biçimlenir", () => {
    expect(formatElapsed(45)).toBe("45 sn");
    expect(formatElapsed(90)).toBe("1 dk 30 sn");
    expect(formatElapsed(120)).toBe("2 dk");
    expect(formatElapsed(10558)).toBe("2 sa 55 dk");
    expect(formatElapsed(9687)).toBe("2 sa 41 dk");
  });

  it("TÜRKÇE ETİKETLER: cleanRoleTitle Türkçe isimler döner", () => {
    expect(cleanRoleTitle("pm")).toBe("PM");
    expect(cleanRoleTitle("interviewer")).toBe("Görüşmeci");
    expect(cleanRoleTitle("standards_auditor")).toBe("Standart Denetçisi");
    expect(cleanRoleTitle("group_lead")).toBe("Grup Lideri");
    expect(cleanRoleTitle("worker")).toBe("Yapan");
    expect(cleanRoleTitle("verifier")).toBe("Denetleyen");
  });
});
