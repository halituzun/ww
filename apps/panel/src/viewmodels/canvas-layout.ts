import type { CanvasNode, CanvasEdge } from "./canvas-edges.js";
import type { OrgPlan, OrgDepartment } from "@ww/shared";
import { agentRoleLabel } from "../services/labels.js";

export interface OrgLayoutResult {
  readonly groupNodes: readonly {
    readonly id: string;
    readonly type: "deptFrame";
    readonly position: { readonly x: number; readonly y: number };
    readonly data: {
      readonly dept: OrgDepartment;
      readonly label: string;
      readonly isCollapsed: boolean;
      readonly hasLead: boolean;
      readonly workerCount: number;
      readonly verifierCount: number;
      readonly responsibility: string;
    };
    readonly style: React.CSSProperties;
  }[];
  readonly augmentedNodes: readonly CanvasNode[];
  readonly nodePositions: ReadonlyMap<string, { readonly x: number; readonly y: number }>;
  readonly edges: readonly CanvasEdge[];
}

export function cleanRoleTitle(role: string): string {
  if (role === "pm") return "PM";
  if (role === "interviewer") return "Görüşmeci";
  if (role === "standards_auditor") return "Standart Denetçisi";
  if (role === "group_lead") return "Grup Lideri";
  if (role === "worker") return "Yapan";
  if (role === "verifier") return "Denetleyen";
  return agentRoleLabel(role);
}

/**
 * Deterministik Organizasyon Yerleşimi ve Kenar Üretimi (Faz E)
 */
export function computeOrgLayout(
  nodes: readonly CanvasNode[],
  orgPlan?: OrgPlan,
  collapsedDepts: ReadonlySet<string> = new Set()
): OrgLayoutResult {
  const nodePositions = new Map<string, { x: number; y: number }>();
  const groupNodes: OrgLayoutResult["groupNodes"][number][] = [];
  const edges: CanvasEdge[] = [];
  const augmentedNodesList: CanvasNode[] = [...nodes];

  const nonClones = [...augmentedNodesList].filter((n) => !n.cloneOf).sort((a, b) => a.id.localeCompare(b.id));
  const clones = [...augmentedNodesList].filter((n) => Boolean(n.cloneOf)).sort((a, b) => a.id.localeCompare(b.id));

  const pmNodes = nonClones.filter((n) => n.role === "pm");
  const interviewerNodes = nonClones.filter((n) => n.role === "interviewer");
  const auditorNodes = nonClones.filter((n) => n.role === "standards_auditor");

  // 1. ÜST KATMAN (Yönetim & Yan Roller)
  // PM merkezde (x: 380, y: 40)
  const pmX = 380;
  const pmY = 40;
  pmNodes.forEach((node, idx) => {
    nodePositions.set(node.id, { x: pmX + idx * 240, y: pmY });
  });

  const mainPm = pmNodes[0];

  // Görüşmeci sol kanatta (x: 40, y: 40)
  interviewerNodes.forEach((node, idx) => {
    nodePositions.set(node.id, { x: 40 + idx * 200, y: 40 });
    if (mainPm) {
      edges.push({
        id: `edge-pm-interviewer-${node.id}`,
        source: mainPm.id,
        target: node.id,
        kind: "hierarchy",
        label: "gereksinim",
      });
    }
  });

  // Standart Denetçisi sağ kanatta (x: 720, y: 40)
  auditorNodes.forEach((node, idx) => {
    nodePositions.set(node.id, { x: 720 + idx * 200, y: 40 });
    if (mainPm) {
      edges.push({
        id: `edge-pm-auditor-${node.id}`,
        source: mainPm.id,
        target: node.id,
        kind: "hierarchy",
        label: "denetim",
      });
    }
  });

  // 2. DEPARTMANLAR VE İÇ DÜĞÜMLER
  const fallbackDepartments: readonly OrgDepartment[] = Object.freeze([
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
          rationale: "Kullanıcı arayüzü ve tasarım",
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
          responsibility_patterns: ["src/timer.js", "src/state.js"],
          rationale: "Çekirdek mantık ve döngü",
        },
      ]);
  const departments = orgPlan?.departments && orgPlan.departments.length > 0
    ? orgPlan.departments
    : fallbackDepartments;

  const deptWidth = 360;
  const deptGap = 30;
  const startY = 200;

  const existingLeads = nonClones.filter((n) => n.role === "group_lead" || n.role === "council_member");
  const existingWorkers = nonClones.filter((n) => n.role === "worker");
  const existingVerifiers = nonClones.filter((n) => n.role === "verifier");

  departments.forEach((dept, deptIdx) => {
    const isCollapsed = collapsedDepts.has(dept.id);
    const deptX = 40 + deptIdx * (deptWidth + deptGap);
    const deptY = startY;

    // Lider düğümü bul veya departman lideri oluştur (E1: Her çerçevenin üstünde lider düğümü)
    let leadNode = existingLeads[deptIdx];
    if (!leadNode) {
      leadNode = {
        id: `lead-${dept.id}`,
        label: `${dept.name.split(" ")[0]} Lideri`,
        role: "group_lead",
        status: "idle",
        modelRef: "ollama:qwen3.6",
        elapsedSec: 60,
        departmentId: dept.id,
      };
      augmentedNodesList.push(leadNode);
    }

    const workers = existingWorkers.filter((_, idx) => idx % departments.length === deptIdx);
    const verifiers = existingVerifiers.filter((_, idx) => idx % departments.length === deptIdx);

    const deptHeight = isCollapsed ? 65 : 295;

    groupNodes.push({
      id: `frame-${dept.id}`,
      type: "deptFrame",
      position: { x: deptX, y: deptY },
      data: {
        dept,
        label: dept.name,
        isCollapsed,
        hasLead: true,
        workerCount: workers.length,
        verifierCount: verifiers.length,
        responsibility: dept.responsibility_patterns.join(", "),
      },
      style: {
        width: deptWidth,
        height: deptHeight,
        background: "rgba(15, 23, 42, 0.75)",
        border: "1px solid rgba(6, 182, 212, 0.3)",
        borderRadius: 12,
        zIndex: -1,
      },
    });

    if (!isCollapsed) {
      // 1. Grup Lideri (Çerçevenin üst orta kısmında x: deptX + 80, y: deptY + 65)
      const leadPos = { x: deptX + 80, y: deptY + 75 };
      nodePositions.set(leadNode.id, leadPos);

      // PM -> Grup Lideri Hiyerarşi Oku (E2)
      if (mainPm) {
        edges.push({
          id: `edge-pm-lead-${leadNode.id}`,
          source: mainPm.id,
          target: leadNode.id,
          kind: "hierarchy",
          label: "yönetir",
        });
      }

      // 2. Yapanlar (Sol) ve Denetleyenler (Sağ)
      workers.forEach((worker, wIdx) => {
        const wPos = { x: deptX + 15, y: deptY + 175 + wIdx * 90 };
        nodePositions.set(worker.id, wPos);

        // Lider -> Worker Hiyerarşi Oku
        edges.push({
          id: `edge-lead-worker-${leadNode.id}-${worker.id}`,
          source: leadNode.id,
          target: worker.id,
          kind: "hierarchy",
        });

        // Worker -> Verifier Doğrulama Oku (Yeşil)
        const matchingVerifier = verifiers[wIdx] || verifiers[0];
        if (matchingVerifier) {
          edges.push({
            id: `edge-verify-${worker.id}-${matchingVerifier.id}`,
            source: worker.id,
            target: matchingVerifier.id,
            kind: "delegates",
            animated: true,
          });
        }
      });

      verifiers.forEach((verifier, vIdx) => {
        const vPos = { x: deptX + 185, y: deptY + 175 + vIdx * 90 };
        nodePositions.set(verifier.id, vPos);
      });
    }

    // Çapraz Denetim (E2): Standart Denetçisi -> Departman Lideri (Turuncu Ok)
    auditorNodes.forEach((auditor) => {
      edges.push({
        id: `edge-audit-${auditor.id}-${leadNode.id}`,
        source: auditor.id,
        target: leadNode.id,
        kind: "audit",
        label: "denetim",
        animated: true,
      });
    });
  });

  // Departmanlar arası kesikli bağımlılık oku (Departman 1 Lideri -> Departman 2 Lideri)
  if (departments.length >= 2) {
    const d1LeadId = augmentedNodesList.find((n) => n.role === "group_lead")?.id;
    const d2LeadId = augmentedNodesList.filter((n) => n.role === "group_lead")[1]?.id;
    if (d1LeadId && d2LeadId) {
      edges.push({
        id: `edge-cross-dept-${d1LeadId}-${d2LeadId}`,
        source: d1LeadId,
        target: d2LeadId,
        kind: "cross_dept",
        label: "bağımlılık",
      });
    }
  }

  // Klonlar
  for (const clone of clones) {
    const parentPos = clone.cloneOf ? nodePositions.get(clone.cloneOf) : undefined;
    if (parentPos) {
      nodePositions.set(clone.id, { x: parentPos.x + 45, y: parentPos.y + 25 });
    } else {
      nodePositions.set(clone.id, { x: 380, y: startY });
    }
  }

  return {
    groupNodes,
    augmentedNodes: augmentedNodesList,
    nodePositions,
    edges,
  };
}
