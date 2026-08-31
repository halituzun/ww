import type { CouncilRoundData } from './council.js';
import { getJson, requestJson, type RequestOptions } from "./http.js";

export interface Plan {
  readonly plan_id: string;
  readonly project_id: string;
  readonly title: string;
  readonly content_md: string;
  readonly status: "proposed" | "approved" | "rejected" | "superseded";
  readonly team_json?: unknown;
  /** Konsey dökümü; sunucu plan gövdesiyle birlikte döndürebilir. */
  readonly transcript?: readonly CouncilRoundData[] | undefined;
  readonly scenarios_json?: unknown;
  readonly plan_version?: number;
  readonly version?: number;
  readonly approved_by?: string;
  readonly created_by_agent_id?: string;
  readonly created_at?: string;
  readonly updated_at?: string;
}

const scope = (projectId: string, path: string): string => `/projects/${projectId}${path}`;

export const fetchPlans = (
  projectId: string,
  options: RequestOptions = {}
): Promise<Plan[]> =>
  getJson<Plan[]>(scope(projectId, "/plans"), options, "Planlar alınamadı");

export const approvePlan = (
  projectId: string,
  planId: string,
  note?: string,
  options: RequestOptions = {}
): Promise<unknown> =>
  requestJson(
    scope(projectId, `/plans/${planId}/approval`),
    {
      ...options,
      method: "POST",
      body: { approved: true, ...(note ? { note } : {}) },
    },
    "Plan onaylanamadı"
  );

export const rejectPlan = (
  projectId: string,
  planId: string,
  note: string,
  options: RequestOptions = {}
): Promise<unknown> =>
  requestJson(
    scope(projectId, `/plans/${planId}/approval`),
    {
      ...options,
      method: "POST",
      body: { approved: false, note },
    },
    "Plan reddedilemedi"
  );

export const requestReplan = (
  projectId: string,
  reason: string,
  summary: string,
  options: RequestOptions = {}
): Promise<unknown> =>
  requestJson(
    scope(projectId, "/plans/replan"),
    {
      ...options,
      method: "POST",
      body: { reason, summary },
    },
    "Yeniden planlama talebi gönderilemedi"
  );
