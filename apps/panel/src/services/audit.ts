// Denetim ekranı IO (docs/08 → Denetim Ekranı).
import { getJson, requestJson, type RequestOptions } from './http.js';

export type AuditFindingStatus = 'open' | 'correction_pending' | 'resolved' | 'dismissed';

export interface AuditFinding {
  findingId: string;
  taskId?: string;
  profile: string;
  severity: string;
  summary: string;
  status: AuditFindingStatus;
  correctiveTaskId?: string;
  resolution?: string;
  createdAt: string;
  updatedAt: string;
}

export interface EscalationEntry {
  eventId: string;
  taskId: string;
  reason: string;
  /** brake:<kind> ise fren tetiklenmesi; boşsa normal tırmandırma. */
  brakeKind: string;
  createdAt: string;
}

/** docs/09 `db_write_audit` (b): ww kayıtlarının tamlığı. */
export interface RecordFinding {
  ruleId: string;
  taskId: string;
  summary: string;
  severity: string;
}

export interface AuditReport {
  projectId: string;
  findings: AuditFinding[];
  counts: Record<AuditFindingStatus, number>;
  escalations: EscalationEntry[];
  brakeTrips: number;
  recordFindings: RecordFinding[];
}

export const EMPTY_AUDIT_REPORT: AuditReport = {
  projectId: '',
  findings: [],
  counts: { open: 0, correction_pending: 0, resolved: 0, dismissed: 0 },
  escalations: [],
  brakeTrips: 0,
  recordFindings: [],
};

/**
 * HATAYI YUTMAZ. Diğer uçlar `getJsonOr` ile varsayılana düşer, ama denetim
 * ekranının İŞİ sorun bildirmektir: rapor alınamadığında boş rapor döndürmek
 * ekrana "0 açık bulgu" dedirtir, yani "denetim temiz" yalanını söyler.
 * Veri gelmemesiyle temiz olmak aynı şey değildir.
 */
export const fetchAuditReport = (
  projectId: string,
  options: RequestOptions = {},
): Promise<AuditReport> =>
  getJson<AuditReport>(`/projects/${encodeURIComponent(projectId)}/audit`, options);

/** Fren türünü kullanıcıya anlaşılır Türkçeye çevirir. */
export function brakeLabel(kind: string): string {
  switch (kind) {
    case 'cost_budget': return 'Bütçe freni';
    case 'token_budget': return 'Token freni';
    case 'wall_clock': return 'Süre freni';
    case 'loop_similarity': return 'Kaçak döngü freni';
    case '': return 'Tırmandırma';
    default: return `Fren (${kind})`;
  }
}

export type Severity = 'critical' | 'warning' | 'neutral';

export function severityTone(severity: string): Severity {
  if (severity === 'critical' || severity === 'high') return 'critical';
  if (severity === 'medium' || severity === 'warning') return 'warning';
  return 'neutral';
}

/**
 * Bulguyu kapatır / reddeder / yeniden açar.
 *
 * NEDEN VAR: denetim ekranı salt-okunurdu — sunucu bulguyu kapatabiliyordu
 * ama kullanıcı kapatamıyordu; yani iş akışı panelde yarım kalıyordu.
 * Gerekçe zorunludur: gerekçesiz kapatma "neden kapandı" sorusunu cevapsız
 * bırakır (sunucu da bunu reddeder).
 */
export async function resolveFinding(
  projectId: string,
  findingId: string,
  input: Readonly<{ status: AuditFindingStatus; resolution?: string; correctiveTaskId?: string }>,
  options: RequestOptions = {},
): Promise<unknown> {
  return requestJson(
    `/projects/${projectId}/audit/findings/${findingId}`,
    { ...options, method: 'PATCH', body: input },
    'Bulgu güncellenemedi',
  );
}

/** Kayıt eksiği kuralını kullanıcıya anlaşılır Türkçeye çevirir. */
export function recordRuleLabel(ruleId: string): string {
  switch (ruleId) {
    case 'REC-001': return 'Commit yok';
    case 'REC-002': return 'Artifact kaydı yok';
    case 'REC-003': return 'Fihriste girmemiş';
    case 'REC-004': return 'Plansız: hiç çalışamaz';
    default: return ruleId;
  }
}
