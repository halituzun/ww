import { z } from "zod";

export const AgentRegisterInputSchema = z.object({
  pair_code: z.string().min(4).max(12),
  db_type: z.string().min(1).max(30),
  host: z.string().default("127.0.0.1"),
  port: z.number().int().positive().default(1433),
  database: z.string().min(1).max(100),
  tables_count: z.number().int().nonnegative().optional().default(0),
  version: z.string().optional().default("0.2.0"),
});
export type AgentRegisterInput = z.infer<typeof AgentRegisterInputSchema>;

export const AgentPollInputSchema = z.object({
  pair_code: z.string().min(4).max(12),
  version: z.string().optional().default("0.2.0"),
  db_type: z.string().optional().default("mssql"),
  status: z.string().optional().default("ready"),
});
export type AgentPollInput = z.infer<typeof AgentPollInputSchema>;

export const AgentResultInputSchema = z.object({
  pair_code: z.string().min(4).max(12),
  query_id: z.string().min(1),
  result: z.object({
    columns: z.array(z.string()).optional().default([]),
    rows: z.array(z.array(z.unknown())).optional().default([]),
    total: z.number().int().optional().default(0),
    elapsed_seconds: z.number().optional(),
    truncated: z.boolean().optional(),
    error: z.string().optional(),
  }),
});
export type AgentResultInput = z.infer<typeof AgentResultInputSchema>;

export const AgentQueryInputSchema = z.object({
  pair_code: z.string().min(4).max(12),
  query: z.string().min(1).max(10000),
  timeout_ms: z.number().int().positive().optional().default(15000),
});
export type AgentQueryInput = z.infer<typeof AgentQueryInputSchema>;

export interface PairedAgentState {
  readonly pair_code: string;
  readonly db_type: string;
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly tables_count: number;
  readonly version: string;
  readonly registered_at: string;
  last_heartbeat_at: string;
  status: string;
}

export interface PendingQuery {
  readonly query_id: string;
  readonly pair_code: string;
  readonly query: string;
  readonly created_at: number;
  readonly timeout_ms: number;
  resolve: (result: AgentResultInput["result"]) => void;
  reject: (err: Error) => void;
}
