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

/**
 * TARİHSEL ÇİFT KODLAMAYA TOLERANS.
 *
 * Çift kodlama artık yazma anında engelleniyor (bkz. appendEvent), ama canlı
 * veritabanında 46 `error` olayı hâlâ JSON METNİ olarak duruyor ve sebepleri
 * okunamıyor. Geçmişi yeniden yazmak kayıt tahrifidir; doğru olan okuyucuyu
 * toleranslı yapmaktır.
 *
 * DÜZ METİN yük ayrıştırılmaya çalışılmaz: onu sessizce yutmak gerçek veriyi
 * kaybetmek olurdu.
 */
function asObject(payload: unknown): Record<string, unknown> | undefined {
  if (payload !== null && typeof payload === 'object') {
    return payload as Record<string, unknown>;
  }
  if (typeof payload !== 'string') return undefined;
  const trimmed = payload.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === 'object'
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

const read = (payload: unknown, key: string): string | undefined => {
  const record = asObject(payload);
  if (record === undefined) return undefined;
  const value = record[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
};

/**
 * Hata sebebi İKİ ŞEKİLDE saklanıyor:
 *  - üst düzey `reason` (execution-error-recorder),
 *  - iç içe `payload.errorCode` / `payload.message` (kalıcı efekt yazıcısı).
 * Canlı veride 69 hata olayının 23'ü ikinci şekildeydi ve anlatıcı yalnız
 * ilkine baktığı için "sebep kaydedilmemiş" diyordu — kayıt var, okunamıyor.
 *
 * Üst düzey `reason` TERCİH edilir: daha açıklayıcıdır (kod değil cümle).
 */
function errorReason(payload: unknown): string | undefined {
  const top = read(payload, 'reason');
  if (top !== undefined) return top;
  const nested = asObject(payload)?.['payload'];
  return read(nested, 'errorCode') ?? read(nested, 'message') ?? read(nested, 'error');
}

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
      const passed = asObject(payload)?.['passed'];
      return `kapı çalıştı: ${passed === true ? 'geçti' : 'geçemedi'}`;
    }
    case 'error':
      return `hata: ${errorReason(payload) ?? 'sebep kaydedilmemiş'}`;
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
      const allowed = asObject(payload)?.['allowed'];
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
