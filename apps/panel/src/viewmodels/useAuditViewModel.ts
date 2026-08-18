// docs/09 → View → ViewModel → Service zinciri.
//
// NEDEN VAR: AuditPanel bir View olmasına rağmen fetch'i, yoklama zamanlayıcısını,
// hata durumunu ve karar akışını kendi içinde tutuyordu. docs/09 View'da
// `fetch`/iş mantığını açıkça yasaklar; bu mantık test edilemez hale gelir ve
// aynı davranış her yeni ekranda yeniden yazılır.
//
// ViewModel DOM'a dokunmaz: yalnızca durum ve kullanıcı eylemleri döner.
import { useCallback, useEffect, useState } from 'react';
import {
  EMPTY_AUDIT_REPORT,
  fetchAuditReport,
  resolveFinding,
  type AuditReport,
} from '../services/audit.js';

export const AUDIT_POLL_MS = 10_000;

export interface AuditViewModel {
  readonly report: AuditReport;
  /** Kullanıcı eyleminden doğan hata (doğrulama, kapatma). */
  readonly error: string;
  /** Raporun kendisi alınamadı. AYRI tutulur: başarılı bir arka plan
   * yenilemesi kullanıcının doğrulama mesajını silmemeli. */
  readonly loadError: string;
  readonly openCount: number;
  noteFor(findingId: string): string;
  setNote(findingId: string, value: string): void;
  decide(findingId: string, status: 'resolved' | 'dismissed'): Promise<void>;
}

export interface AuditViewModelPorts {
  fetchReport?: typeof fetchAuditReport;
  resolve?: typeof resolveFinding;
  pollMs?: number;
}

export function useAuditViewModel(
  projectId: string,
  ports: AuditViewModelPorts = {},
): AuditViewModel {
  const load = ports.fetchReport ?? fetchAuditReport;
  const resolve = ports.resolve ?? resolveFinding;
  const pollMs = ports.pollMs ?? AUDIT_POLL_MS;

  const [report, setReport] = useState<AuditReport>(EMPTY_AUDIT_REPORT);
  // Karar kullanıcıdan gelir; gerekçesiz kapatmayı sunucu da reddeder.
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  // YÜKLEME hatası KULLANICI hatasından ayrıdır. Tek alanda tutmak, başarılı
  // bir arka plan yenilemesinin kullanıcının doğrulama mesajını ("gerekçe
  // zorunludur") sessizce silmesine yol açıyordu.
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    if (!projectId) return;
    let active = true;
    const refresh = (): void => {
      void load(projectId)
        .then((next) => { if (active) { setReport(next); setLoadError(''); } })
        .catch((reason: unknown) => {
          // Hata YUTULURSA ekran "0 açık bulgu" der, yani "denetim temiz"
          // yalanını söyler. Veri gelmemesiyle temiz olmak aynı şey değildir.
          // Aynı kural useCanvasViewModel'de yazılı; burada unutulmuştu.
          if (active) {
            setLoadError(reason instanceof Error ? reason.message : 'Denetim raporu alınamadı');
          }
        });
    };
    refresh();
    const timer = window.setInterval(refresh, pollMs);
    return () => { active = false; window.clearInterval(timer); };
  }, [projectId, load, pollMs]);

  const decide = useCallback(async (
    findingId: string,
    status: 'resolved' | 'dismissed',
  ): Promise<void> => {
    const resolution = (notes[findingId] ?? '').trim();
    if (resolution === '') {
      setError('Kapatma gerekçesi zorunludur.');
      return;
    }
    try {
      await resolve(projectId, findingId, { status, resolution });
      setError('');
      setReport(await load(projectId));
    } catch (reason) {
      // Hata yutulursa kullanıcı bulguyu kapattığını sanır.
      setError(reason instanceof Error ? reason.message : 'Bulgu güncellenemedi');
    }
  }, [notes, projectId, resolve, load]);

  return {
    report,
    error,
    loadError,
    openCount: report.counts.open + report.counts.correction_pending,
    noteFor: (findingId) => notes[findingId] ?? '',
    setNote: (findingId, value) => setNotes((current) => ({ ...current, [findingId]: value })),
    decide,
  };
}
