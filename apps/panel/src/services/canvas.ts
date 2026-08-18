// Canlı tuval verisi (docs/08 → "ilk yük REST GET /projects/:id/canvas").
import { getJson, type RequestOptions } from './http.js';

export interface CanvasNode {
  id: string;
  label: string;
  role: string;
  group: string;
  modelRef: string;
  status: string;
  cloneOf?: string;
  currentTaskId?: string;
}

export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  kind: 'hierarchy' | 'assignment' | 'verification' | 'clone';
  label: string;
  animated: boolean;
  taskId?: string;
}

export interface CanvasData {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

export const fetchCanvas = (
  projectId: string,
  options: RequestOptions = {},
): Promise<CanvasData> =>
  getJson<CanvasData>(`/projects/${projectId}/canvas`, options, 'Tuval verisi alınamadı');
