// Süreç yaşam döngüsü olayları — docs/10 Ortak Davranışlar: "Her ortam
// başlat/durdur olayları `events`'e yazılır; süreç çökerse panelde rozet +
// tek tık yeniden başlatma."
//
// NEDEN VAR: `process_started` / `process_stopped` olay türleri şemada
// TANIMLIYDI ama hiçbir üretim kodu onları yazmıyordu; canlı veritabanında
// sıfır satır. Yani önizleme açılıp kapanıyor, zaman çizelgesinde hiç iz
// kalmıyordu ve "süreç çöktü" rozetinin besleneceği veri yoktu.
import { createHash } from 'node:crypto';
import { NIL_UUID } from '@ww/shared';

export interface ProcessLifecycleInput {
  readonly projectId: string;
  /** Hangi ortam: dev sunucusu ya da emülatör. */
  readonly kind: 'dev' | 'emulator';
  readonly state: 'started' | 'stopped';
  readonly occurredAt: string;
  readonly port?: number | undefined;
  readonly reason?: string | undefined;
}

/**
 * Kimlik İÇERİKTEN türetilir: aynı olayın iki kez yazılması zaman çizelgesini
 * şişirir ve "kaç kez yeniden başladı" sorusuna yanlış cevap verdirir.
 */
function deterministicId(input: ProcessLifecycleInput): string {
  const hex = createHash('sha256')
    .update([input.projectId, input.kind, input.state, input.occurredAt, String(input.port ?? '')].join('|'))
    .digest('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join('-');
}

export function processLifecycleEvent(input: ProcessLifecycleInput) {
  return {
    event_id: deterministicId(input),
    seq: '0',
    project_id: input.projectId,
    task_id: NIL_UUID,
    agent_id: NIL_UUID,
    event_type: input.state === 'started' ? 'process_started' : 'process_stopped',
    tool_name: 'preview.service',
    // NESNE yazılır; JSON metni çift kodlamaya yol açar (appendEvent bunu
    // artık reddediyor).
    payload: {
      kind: input.kind,
      ...(input.port === undefined ? {} : { port: input.port }),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    },
    duration_ms: 0,
    created_at: input.occurredAt,
  };
}
