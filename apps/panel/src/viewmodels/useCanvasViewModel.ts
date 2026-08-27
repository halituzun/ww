// docs/09 View → ViewModel → Service; docs/08 canlı tuval.
//
// NEDEN VAR: tuval GÖREVLERİ çiziyordu, oysa docs/08 tuvali agent'ların
// organizasyon şeması olarak tanımlar ("kim kime iş verdi"). Uç de yoktu.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchCanvas, type CanvasData, type CanvasNode, type CanvasEdge } from '../services/canvas.js';

export const CANVAS_POLL_MS = 5_000;

const EMPTY: CanvasData = { nodes: [], edges: [] };

/** B4 — Rol filtresi seçenekleri. */
export type RoleFilter = 'all' | 'workers' | 'verifiers';

export interface CanvasViewModelPorts {
  load?: typeof fetchCanvas;
  pollMs?: number;
}

/**
 * B4 — Seçili bir agent'ın alt ağacını (kendisi + ona bağlı herkes) döndürür.
 * Boş alana tıklayınca seçim kalkar, gerisi soluklaşmaz.
 */
function subtreeOf(selectedId: string | undefined, nodes: readonly CanvasNode[], edges: readonly CanvasEdge[]): Set<string> | undefined {
  if (!selectedId) return undefined;
  const result = new Set<string>([selectedId]);
  // Seçili düğümden çıkan/gelen kenarlardaki düğümleri ekle (1 derinlik)
  for (const e of edges) {
    if (e.source === selectedId) result.add(e.target);
    if (e.target === selectedId) result.add(e.source);
  }
  return result;
}

export function useCanvasViewModel(projectId: string, ports: CanvasViewModelPorts = {}) {
  const load = ports.load ?? fetchCanvas;
  const pollMs = ports.pollMs ?? CANVAS_POLL_MS;
  const [data, setData] = useState<CanvasData>(EMPTY);
  const [error, setError] = useState('');

  // B4 — Rol filtresi ve seçim
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('all');
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>(undefined);

  const clearSelection = useCallback(() => setSelectedNodeId(undefined), []);

  useEffect(() => {
    if (!projectId) return;
    let active = true;
    const refresh = (): void => {
      void load(projectId)
        .then((next) => { if (active) { setData(next); setError(''); } })
        .catch((reason: unknown) => {
          // Hata yutulursa boş tuval "hiç agent yok" yalanını söyler.
          if (active) setError(reason instanceof Error ? reason.message : 'Tuval alınamadı');
        });
    };
    refresh();
    const timer = window.setInterval(refresh, pollMs);
    return () => { active = false; window.clearInterval(timer); };
  }, [projectId, load, pollMs]);

  // B4 — Rol filtresine göre daraltılmış veri
  const filteredData = useMemo((): CanvasData => {
    if (roleFilter === 'all') return data;
    const keep = new Set<string>();
    for (const n of data.nodes) {
      if (roleFilter === 'workers' && (n.role === 'worker' || n.role === 'pm' || n.role === 'group_lead')) keep.add(n.id);
      if (roleFilter === 'verifiers' && (n.role === 'verifier' || n.role === 'standards_auditor' || n.role === 'pm')) keep.add(n.id);
    }
    const nodes = data.nodes.filter((n) => keep.has(n.id));
    const edges = data.edges.filter((e) => keep.has(e.source) && keep.has(e.target));
    return { nodes, edges };
  }, [data, roleFilter]);

  // B4 — Seçim alt ağacı (undefined = hepsi normal)
  const highlightSet = useMemo(
    () => subtreeOf(selectedNodeId, filteredData.nodes, filteredData.edges),
    [selectedNodeId, filteredData]
  );

  return {
    data: filteredData,
    rawData: data,
    error,
    roleFilter, setRoleFilter,
    selectedNodeId, setSelectedNodeId, clearSelection,
    highlightSet,
  };
}
