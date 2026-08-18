// docs/09 View → ViewModel → Service; docs/08 canlı tuval.
//
// NEDEN VAR: tuval GÖREVLERİ çiziyordu, oysa docs/08 tuvali agent'ların
// organizasyon şeması olarak tanımlar ("kim kime iş verdi"). Uç de yoktu.
import { useEffect, useState } from 'react';
import { fetchCanvas, type CanvasData } from '../services/canvas.js';

export const CANVAS_POLL_MS = 5_000;

const EMPTY: CanvasData = { nodes: [], edges: [] };

export interface CanvasViewModelPorts {
  load?: typeof fetchCanvas;
  pollMs?: number;
}

export function useCanvasViewModel(projectId: string, ports: CanvasViewModelPorts = {}) {
  const load = ports.load ?? fetchCanvas;
  const pollMs = ports.pollMs ?? CANVAS_POLL_MS;
  const [data, setData] = useState<CanvasData>(EMPTY);
  const [error, setError] = useState('');

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

  return { data, error };
}
