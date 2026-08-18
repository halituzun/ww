// Olayların anlatıya uygun özetlere çevrilmesi (docs/06 → "nasıl yaptın").
//
// NEDEN VAR: narrator kanıt olarak HAM JSON yükünü alıyordu ve cevabı
// `recovery_completed: {"idledAgentIds":[],...} lock_acquired: {...}` gibi
// okunamaz bir döküm oluyordu. Cevap gibi görünen okunamaz çıktı, boş
// cevaptan kötüdür: kullanıcı bir şey anlatıldığını sanır.
export interface NarratableEvent {
  readonly event_type: string;
  readonly tool_name?: string;
  readonly payload?: unknown;
  readonly created_at?: string;
}

const read = (payload: unknown, key: string): string | undefined => {
  if (payload === null || typeof payload !== 'object') return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
};

/** Tek olayın insan cümlesi. Bilinmeyen tür için tür adı korunur, uydurulmaz. */
export function narrateEvent(event: NarratableEvent): string {
  const payload = event.payload;
  switch (event.event_type) {
    case 'status_change': {
      const to = read(payload, 'toStatus');
      const action = read(payload, 'action');
      return to === undefined
        ? 'görev durumu değişti'
        : `görev ${action === undefined ? '' : `'${action}' ile `}${to} durumuna geçti`;
    }
    case 'tool_call':
      return `araç çağrıldı: ${event.tool_name ?? read(payload, 'name') ?? 'bilinmiyor'}`;
    case 'tool_result':
      return `araç sonucu alındı: ${event.tool_name ?? 'bilinmiyor'}`;
    case 'lock_acquired':
      return `dosya kilidi alındı: ${read(payload, 'path') ?? 'bilinmiyor'}`;
    case 'lock_released':
      return `dosya kilidi bırakıldı: ${read(payload, 'path') ?? 'bilinmiyor'}`;
    case 'brief_sealed':
      return 'görev brief’i mühürlendi';
    case 'test_run': {
      const passed = (payload as { passed?: unknown } | null)?.passed;
      return `kapı çalıştı: ${passed === true ? 'geçti' : 'geçemedi'}`;
    }
    case 'error':
      return `hata: ${read(payload, 'reason') ?? 'sebep kaydedilmemiş'}`;
    case 'recovery_completed':
      return 'kurtarma turu tamamlandı';

    // Aşağıdaki türler hiç çevrilmiyordu ve anlatı onlarda ham tür adı
    // basıyordu. Canlı veride 7 tür / 128 olay böyleydi — üstelik anlatının
    // EN ÖNEMLİ olayları buradaydı: commit, tırmandırma, devir.
    case 'commit': {
      const hash = read(payload, 'commitHash') ?? read(payload, 'commit_hash');
      // Hash yoksa uydurulmaz; olayın kendisi yine de anlatılır.
      return hash === undefined
        ? 'değişiklik commit edildi'
        : `değişiklik commit edildi: ${hash.slice(0, 7)}`;
    }
    case 'escalation':
      return `tırmandırıldı: ${read(payload, 'reason') ?? 'sebep kaydedilmemiş'}`;
    case 'task_handoff': {
      const to = read(payload, 'toAgentId') ?? read(payload, 'to');
      return `görev devredildi${to === undefined ? '' : `: ${to}`}`;
    }
    case 'message_stored':
      return `mesaj kaydedildi: ${read(payload, 'kind') ?? 'tür bilinmiyor'}`;
    case 'message_rejected':
      return `mesaj reddedildi: ${read(payload, 'reason') ?? 'sebep kaydedilmemiş'}`;
    case 'policy_decision': {
      const allowed = (payload as { allowed?: unknown } | null)?.allowed;
      const reason = read(payload, 'reason');
      const verdict = allowed === false ? 'reddetti' : 'izin verdi';
      return `politika ${verdict}${reason === undefined ? '' : `: ${reason}`}`;
    }
    case 'receipt_changed':
      return `mesaj makbuzu güncellendi: ${read(payload, 'state') ?? 'durum bilinmiyor'}`;
    default:
      // Bilinmeyen türü JSON'a çevirmek eski okunamaz dökümü geri getirir.
      return event.event_type;
  }
}
