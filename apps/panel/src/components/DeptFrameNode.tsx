import React from "react";
import type { Node, NodeProps } from "@xyflow/react";
import type { OrgDepartment } from "@ww/shared";
import { agentGroupLabel } from "../services/labels.js";

export interface DeptFrameData extends Record<string, unknown> {
  readonly dept: OrgDepartment;
  readonly label: string;
  readonly isCollapsed: boolean;
  readonly hasLead: boolean;
  readonly workerCount: number;
  readonly verifierCount: number;
  readonly responsibility: string;
  readonly onToggleCollapse?: ((deptId: string) => void) | undefined;
}

type DeptFrameNodeType = Node<DeptFrameData, 'deptFrame'>;

export function DeptFrameNode({ data }: NodeProps<DeptFrameNodeType>) {
  const { dept, label, isCollapsed, hasLead, workerCount, verifierCount, responsibility, onToggleCollapse } = data as unknown as DeptFrameData;

  const groupText = dept?.group ? agentGroupLabel(dept.group) : "Grup";
  const memberSummary = `${hasLead ? "1 lider · " : ""}${workerCount} yapan, ${verifierCount} denetleyen`;

  return (
    <div
      className="dept-frame-node"
      style={{
        width: "100%",
        height: "100%",
        borderRadius: "12px",
        border: "1px solid rgba(6, 182, 212, 0.35)",
        background: "rgba(15, 23, 42, 0.7)",
        backdropFilter: "blur(10px)",
        padding: "10px 14px",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        pointerEvents: "all",
      }}
    >
      {/* 1. Satır: Başlık, Grup Rozeti, Üye Sayısı ve Daralt/Genişlet Butonu */}
      <div
        className="dept-frame-header"
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "8px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
          <span
            style={{
              fontSize: "13px",
              fontWeight: 600,
              color: "#67e8f9",
              letterSpacing: "0.2px",
            }}
          >
            {label}
          </span>
          <span
            className="pill pill--mini"
            style={{
              background: "rgba(6, 182, 212, 0.15)",
              color: "#67e8f9",
              border: "1px solid rgba(6, 182, 212, 0.3)",
              fontSize: "10px",
              padding: "1px 6px",
            }}
          >
            {groupText}
          </span>
          <span className="pill pill--mini" style={{ fontSize: "10px", padding: "1px 6px" }}>
            {memberSummary}
          </span>
        </div>

        {onToggleCollapse ? (
          <button
            type="button"
            className="linklike"
            style={{ fontSize: "11px", color: "#94a3b8", cursor: "pointer", whiteSpace: "nowrap" }}
            onClick={(e) => {
              e.stopPropagation();
              onToggleCollapse(dept.id);
            }}
          >
            {isCollapsed ? "Genişlet ↓" : "Daralt ↑"}
          </button>
        ) : null}
      </div>

      {/* 2. Satır (Başlığın hemen altı): Sorumluluk Desenleri */}
      {!isCollapsed && responsibility ? (
        <div
          className="dept-frame-responsibility"
          style={{
            marginTop: "4px",
            padding: "4px 8px",
            background: "rgba(15, 23, 42, 0.6)",
            borderRadius: "6px",
            border: "1px solid rgba(255, 255, 255, 0.05)",
            fontSize: "10px",
            color: "#94a3b8",
            display: "flex",
            gap: "6px",
            alignItems: "center",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxHeight: "22px",
          }}
          title={`Sorumluluk Alanı: ${responsibility}`}
        >
          <span style={{ color: "#64748b", fontWeight: 500 }}>Sorumluluk:</span>
          <code style={{ color: "#10b981", fontSize: "10px" }}>{responsibility}</code>
        </div>
      ) : null}
    </div>
  );
}
