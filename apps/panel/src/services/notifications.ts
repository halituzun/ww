// Bildirim merkezi türetmesi (docs/08 → Bildirimler).
//
// Panel önceden HER WebSocket olayında tarayıcı bildirimi atıyordu: gürültülü
// ve belgelenen kaynak listesine uymuyordu. Bildirimler artık docs/08'deki
// kaynaklardan türetilir ve kimlikleri KARARLIDIR — aksi halde "görüldü"
// işareti her yenilemede sıfırlanırdı.
import { brakeLabel, recordRuleLabel } from './audit.js';
import type { BudgetState } from './budget.js';

export type NotificationKind = 'budget' | 'provider' | 'question' | 'escalation' | 'record';
export type NotificationTone = 'critical' | 'warning' | 'info';

export interface PanelNotification {
  /** Kararlı kimlik: görüldü işareti buna dayanır. */
  id: string;
  kind: NotificationKind;
  tone: NotificationTone;
  title: string;
  detail: string;
}

export interface NotificationSignals {
  budget?: { state: BudgetState; ratio: number } | undefined;
  providers?: readonly { provider_id: string; health_status?: string | undefined; enabled: boolean }[] | undefined;
  tasks?: readonly { task_id: string; title: string; status: string }[] | undefined;
  escalations?: readonly { eventId: string; taskId: string; reason: string; brakeKind: string }[] | undefined;
  /**
   * docs/09 `db_write_audit` bulguları. Denetim ekranında görünüyorlardı ama
   * ZİL ÇALMIYORDU: kalıcı olarak ölü bir görev (REC-004), kullanıcı denetim
   * ekranını açmayı akıl etmedikçe fark edilmiyordu.
   */
  recordFindings?: readonly {
    ruleId: string; taskId: string; summary: string; severity: string;
  }[] | undefined;
}

const TONE_ORDER: Record<NotificationTone, number> = { critical: 0, warning: 1, info: 2 };

export function deriveNotifications(signals: NotificationSignals): PanelNotification[] {
  const out: PanelNotification[] = [];

  if (signals.budget?.state === 'exceeded') {
    out.push({
      id: 'budget:exceeded', kind: 'budget', tone: 'critical',
      title: 'Bütçe aşıldı',
      detail: `Proje bütçesinin %${Math.round(signals.budget.ratio * 100)}'i harcandı.`,
    });
  } else if (signals.budget?.state === 'warning') {
    out.push({
      id: 'budget:warning', kind: 'budget', tone: 'warning',
      title: 'Bütçe sınırına yaklaşıldı',
      detail: `Proje bütçesinin %${Math.round(signals.budget.ratio * 100)}'i harcandı.`,
    });
  }

  for (const provider of signals.providers ?? []) {
    // Pasif sağlayıcı bilinçli kapatılmıştır; uyarısı gürültüdür.
    if (!provider.enabled) continue;
    if (provider.health_status === 'down') {
      out.push({
        id: `provider:${provider.provider_id}:down`, kind: 'provider', tone: 'critical',
        title: 'Sağlayıcı düştü',
        detail: `${provider.provider_id} yanıt vermiyor; işler fallback zincirine akacak.`,
      });
    } else if (provider.health_status === 'degraded') {
      out.push({
        id: `provider:${provider.provider_id}:degraded`, kind: 'provider', tone: 'warning',
        title: 'Sağlayıcı sorunlu',
        detail: `${provider.provider_id} hata oranı yüksek.`,
      });
    }
  }

  for (const task of signals.tasks ?? []) {
    if (task.status !== 'waiting_user') continue;
    out.push({
      id: `question:${task.task_id}`, kind: 'question', tone: 'warning',
      title: 'Cevabın bekleniyor',
      detail: task.title,
    });
  }

  for (const finding of signals.recordFindings ?? []) {
    out.push({
      // Aynı görev + kural için TEK kimlik: bulgular her taramada yeniden
      // üretilir ve kimlik değişse zil sürekli çalardı.
      id: `record:${finding.ruleId}:${finding.taskId}`,
      kind: 'record',
      tone: finding.severity === 'high' || finding.severity === 'critical'
        ? 'critical'
        : 'warning',
      title: recordRuleLabel(finding.ruleId),
      detail: finding.summary,
    });
  }

  for (const escalation of signals.escalations ?? []) {
    out.push({
      id: `escalation:${escalation.eventId}`, kind: 'escalation',
      tone: escalation.brakeKind === '' ? 'warning' : 'critical',
      title: brakeLabel(escalation.brakeKind),
      detail: escalation.reason,
    });
  }

  // Aynı kimlik iki kez görünmesin (ör. yinelenen olay satırı).
  const unique = new Map(out.map((notification) => [notification.id, notification]));
  return [...unique.values()].sort((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone]);
}

export function unseenCount(
  notifications: readonly PanelNotification[],
  seen: ReadonlySet<string>,
): number {
  return notifications.filter((notification) => !seen.has(notification.id)).length;
}

const STORAGE_KEY = 'ww:seen-notifications';

export function loadSeen(storage: Pick<Storage, 'getItem'> = localStorage): Set<string> {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
  } catch {
    return new Set();
  }
}

export function saveSeen(
  seen: ReadonlySet<string>,
  storage: Pick<Storage, 'setItem'> = localStorage,
): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify([...seen]));
  } catch {
    // Depolama kapalıysa bildirimler yine çalışır; yalnız görüldü kalıcı olmaz.
  }
}
