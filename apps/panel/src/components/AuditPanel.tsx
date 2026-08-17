import { useEffect, useState } from 'react';
import {
  brakeLabel,
  fetchAuditReport,
  resolveFinding,
  severityTone,
  EMPTY_AUDIT_REPORT,
  type AuditReport,
} from '../services/audit.js';

const STATUS_LABEL: Record<string, string> = {
  open: 'Açık',
  correction_pending: 'Düzeltme bekliyor',
  resolved: 'Kapandı',
  dismissed: 'Reddedildi',
};

// docs/08 → Denetim Ekranı: denetçi bulguları, tırmandırma geçmişi, fren olayları.
export function AuditPanel({ projectId }: { projectId: string }) {
  const [report, setReport] = useState<AuditReport>(EMPTY_AUDIT_REPORT);
  // Karar kullanıcıdan gelir; gerekçesiz kapatmayı sunucu da reddeder.
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState('');

  const decide = async (findingId: string, status: 'resolved' | 'dismissed') => {
    const resolution = (notes[findingId] ?? '').trim();
    if (resolution === '') {
      setError('Kapatma gerekçesi zorunludur.');
      return;
    }
    try {
      await resolveFinding(projectId, findingId, { status, resolution });
      setError('');
      setReport(await fetchAuditReport(projectId));
    } catch (reason) {
      // Hata yutulursa kullanıcı bulguyu kapattığını sanır.
      setError(reason instanceof Error ? reason.message : 'Bulgu güncellenemedi');
    }
  };

  useEffect(() => {
    if (!projectId) return;
    let active = true;
    const load = () => {
      void fetchAuditReport(projectId).then((next) => { if (active) setReport(next); });
    };
    load();
    const timer = window.setInterval(load, 10_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [projectId]);

  const openCount = report.counts.open + report.counts.correction_pending;

  return (
    <section className="audit-panel" aria-label="Denetim">
      <div className="section-heading">
        <h3>Denetim</h3>
        <small>Denetçi bulguları, tırmandırmalar ve fren olayları</small>
      </div>

      <div className="budget-tiles">
        <div className={`budget-tile${openCount > 0 ? ' budget-tile--attention' : ''}`}>
          <strong>{openCount}</strong><span>Açık bulgu</span>
        </div>
        <div className="budget-tile"><strong>{report.counts.resolved}</strong><span>Kapanan</span></div>
        <div className={`budget-tile${report.brakeTrips > 0 ? ' budget-tile--attention' : ''}`}>
          <strong>{report.brakeTrips}</strong><span>Fren tetiklenmesi</span>
        </div>
        <div className="budget-tile">
          <strong>{report.escalations.length}</strong><span>Tırmandırma</span>
        </div>
      </div>

      {report.findings.length > 0 ? (
        <div className="budget-block">
          <h4>Bulgular</h4>
          <ul className="audit-findings">
            {error !== '' ? <li className="audit-error">{error}</li> : null}
            {report.findings.map((finding) => (
              <li key={finding.findingId} className={`audit-finding audit-finding--${severityTone(finding.severity)}`}>
                <div className="audit-finding__head">
                  <span className="pill">{finding.profile}</span>
                  <strong>{finding.summary}</strong>
                </div>
                <div className="audit-finding__meta">
                  <span>{STATUS_LABEL[finding.status] ?? finding.status}</span>
                  {finding.correctiveTaskId
                    ? <span>düzeltme görevi <code>{finding.correctiveTaskId.slice(0, 8)}</code></span>
                    : null}
                  {finding.taskId ? <code>{finding.taskId.slice(0, 8)}</code> : null}
                </div>
                {finding.status === 'open' || finding.status === 'correction_pending' ? (
                  <div className="audit-finding__actions">
                    <input
                      aria-label={`Gerekçe ${finding.findingId}`}
                      placeholder="Kapatma gerekçesi"
                      value={notes[finding.findingId] ?? ''}
                      onChange={(event) => setNotes((current) => ({
                        ...current, [finding.findingId]: event.target.value,
                      }))}
                    />
                    <button type="button" onClick={() => void decide(finding.findingId, 'resolved')}>
                      Kapat
                    </button>
                    <button type="button" onClick={() => void decide(finding.findingId, 'dismissed')}>
                      Reddet
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {report.escalations.length > 0 ? (
        <div className="budget-block">
          <h4>Tırmandırma ve fren geçmişi</h4>
          <ol className="audit-escalations">
            {report.escalations.map((entry) => (
              <li key={entry.eventId} className={entry.brakeKind ? 'audit-escalation--brake' : ''}>
                {/* Renk tek başına anlam taşımaz: tür her zaman etiketle yazılır. */}
                <span className="pill">{brakeLabel(entry.brakeKind)}</span>
                <span className="audit-escalation__reason">{entry.reason}</span>
                <code>{entry.taskId.slice(0, 8)}</code>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {report.findings.length === 0 && report.escalations.length === 0 ? (
        <p className="hint">Henüz denetim bulgusu veya tırmandırma yok.</p>
      ) : null}
    </section>
  );
}
