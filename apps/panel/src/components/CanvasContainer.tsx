import React from "react";
import {
  ReactFlow,
  Background,
  Controls,
  type ReactFlowProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

export interface CanvasContainerProps extends Omit<ReactFlowProps, "children"> {
  readonly children?: React.ReactNode;
  readonly className?: string;
  readonly style?: React.CSSProperties;
}

/**
 * Ortak React Flow Tuval Sarmalayıcısı
 * - Karanlık tema ayarları merkezidir: koyu ızgara (#1e293b), sağ alt kontroller, filigran gizli.
 * - Tüm tuvaller (Agent Organizasyonu, Görev Akışı, Gantt vb.) bu sarmalayıcıyı kullanır.
 */
export function CanvasContainer({
  children,
  className = "",
  style,
  nodes,
  edges,
  fitView = true,
  fitViewOptions = { padding: 0.2 },
  proOptions = { hideAttribution: true },
  ...rest
}: CanvasContainerProps) {
  return (
    <div
      className={`flow-canvas-container ${className}`}
      style={{ width: "100%", height: "100%", minHeight: 520, position: "relative", ...style }}
    >
      <ReactFlow
        nodes={nodes ?? []}
        edges={edges ?? []}
        fitView={fitView}
        fitViewOptions={fitViewOptions}
        proOptions={proOptions}
        {...rest}
      >
        <Background color="#1e293b" gap={16} size={1} />
        <Controls
          position="bottom-right"
          className="canvas-controls"
          showInteractive={false}
        />
        {children}
      </ReactFlow>
    </div>
  );
}
