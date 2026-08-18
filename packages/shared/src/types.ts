import { z } from 'zod';
import { EntityIdSchema } from './identity.js';

// WebSocket olay zarfı — docs/08-panel.md sözleşmesi.
export interface WsEnvelope<T = unknown> {
  event: string;
  projectId: string;
  /**
   * Olayın ait olduğu görev. `events.task_id` bir KOLONDUR, payload'ın içinde
   * değildir: zarfa konmayınca panel bir olayı hangi görevin ürettiğini
   * bilemiyordu ve tuvalin zaman çizelgesi her görevi "bilinmiyor" gösterirdi.
   * Görevle ilgisi olmayan olaylarda boş dizedir.
   */
  taskId: string;
  /**
   * OPAK imleç (docs/08). `seq` UInt64'tür; `number` olarak taşınması 2^53
   * üstünde KAYIPLIDIR ve canlı veritabanında olayların %65'i o sınırın
   * üstündedir. Kırpılan değerler eşitlenince panel onları "tekrar" sanıp
   * atıyordu. Metin olarak taşımak kayıpsızdır ve dokümanın zaten
   * söylediğidir: "`events.seq` alanı public istemci sözleşmesi değildir".
   */
  cursor: string;
  ts: string;
  data: T;
}

/** Orkestrasyon runtime durumu; kapalıysa görev kuyruğu tüketilmez. */
export interface RuntimeHealth {
  readonly orchestration: 'enabled' | 'disabled' | 'misconfigured';
  readonly tasksProcessed: boolean;
  readonly reason: string;
}

export interface HealthReport {
  ok: boolean;
  clickhouse: boolean;
  redis: boolean;
}

// api_usage satırı — docs/02-clickhouse-semasi.md ile birebir (created_at DB katmanında eklenir).
export interface ApiUsageRow {
  usage_id: string;
  project_id: string;
  agent_id: string;
  task_id: string;
  provider_id: string;
  model: string;
  /** 'council': konsey turu — gerçek çağrı, ama göreve bağlı provenance yok. */
  purpose: 'completion' | 'embedding' | 'health_check' | 'council';
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  latency_ms: number;
  status: 'ok' | 'error' | 'timeout' | 'rate_limited' | 'fallback_used';
  error_kind: string;
  // Phase 1 communication provenance. Optional until provider wiring lands in Phase 7.
  invocation_id?: string;
  task_brief_id?: string;
  assignment_attempt_id?: string;
  prompt_input_snapshot_id?: string;
  fallback_attempt?: number;
}

export const ProviderInvocationProvenanceV1Schema = z.strictObject({
  invocationId: EntityIdSchema,
  taskBriefId: EntityIdSchema,
  assignmentAttemptId: EntityIdSchema,
  promptInputSnapshotId: EntityIdSchema,
  fallbackAttempt: z.number().int().nonnegative(),
}).readonly();

export type ProviderInvocationProvenanceV1 = z.infer<
  typeof ProviderInvocationProvenanceV1Schema
>;
