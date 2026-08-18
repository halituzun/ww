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

export interface AgentTaskSummary {
  taskId: string;
  title: string;
  status: string;
  relation: 'issuer' | 'worker' | 'verifier';
}

export interface AgentDetail {
  agentId: string;
  name: string;
  role: string;
  group: string;
  modelRef: string;
  status: string;
  tasksDone: number;
  tasksRejected: number;
  tasks: AgentTaskSummary[];
  messageCount: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  calls: number;
}

export const fetchAgentDetail = (
  projectId: string,
  agentId: string,
  options: RequestOptions = {},
): Promise<AgentDetail> =>
  getJson<AgentDetail>(`/projects/${projectId}/agents/${agentId}`, options,
    'Agent geçmişi alınamadı');
