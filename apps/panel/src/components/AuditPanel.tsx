import { auditProfileLabel } from '../services/labels.js';
import { brakeLabel, recordRuleLabel, severityTone } from '../services/audit.js';
import {
  useAuditViewModel, type AuditViewModelPorts,
} from '../viewmodels/useAuditViewModel.js';

const STATUS_LABEL: Record<string, string> = {
  open: 'Açık',
  correction_pending: 'Düzeltme bekliyor',
  resolved: 'Kapandı',
  dismissed: 'Reddedildi',
};

// docs/08 → Denetim Ekranı: denetçi bulguları, tırmandırma geçmişi, fren olayları.
export function AuditPanel({ projectId, ports }: {
  readonly projectId: string;
  /** Testler gerçek uca gitmeden görünümü sürebilsin diye (bkz. AgentDetail). */
  readonly ports?: AuditViewModelPorts;
}) {
  // docs/09: View'da fetch/iş mantığı yasak — hepsi ViewModel'de.
  const {
    report, error, loadError, openCount, noteFor, setNote, decide,
  } = useAuditViewModel(projectId, ports);

  return (
    <section className="audit-panel" aria-label="Denetim">
      <div className="section-heading">
        <h3>Denetim</h3>
        <small>Denetçi bulguları, tırmandırmalar ve fren olayları</small>
      </div>

      {/* HATA EN ÜSTTE. Eskiden bulgu listesinin İÇİNDEYDİ: rapor hiç
          alınamadığında liste boş olduğu için hata da HİÇ görünmüyor, ekran
          "0 açık bulgu" diyordu — yani "denetim temiz" yalanını söylüyordu.
          Veri gelmemesiyle temiz olmak aynı şey değildir. */}
      {loadError === '' ? null : (
        <p className="audit-error" role="alert">{loadError}</p>
      )}
      {error === '' ? null : (
        <p className="audit-error" role="alert">{error}</p>
      )}

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

      {report.recordFindings.length > 0 ? (
        <div className="budget-block">
          {/* docs/09 db_write_audit (b): "iş bitti ama kaydı yok" durumu.
              Uca eklenip burada gösterilmeseydi bulgu görünmez kalırdı. */}
          <h4>Kayıt eksikleri</h4>
          <ul className="audit-findings">
            {report.recordFindings.map((finding) => (
              <li
                key={`${finding.ruleId}:${finding.taskId}`}
                className={`audit-finding audit-finding--${severityTone(finding.severity)}`}
              >
                <div className="audit-finding__head">
                  <span className="pill">{recordRuleLabel(finding.ruleId)}</span>
                  <strong>{finding.summary}</strong>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {report.findings.length > 0 ? (
        <div className="budget-block">
          <h4>Bulgular</h4>
          <ul className="audit-findings">
            {report.findings.map((finding) => (
              <li key={finding.findingId} className={`audit-finding audit-finding--${severityTone(finding.severity)}`}>
                <div className="audit-finding__head">
                  <span className="pill">{auditProfileLabel(finding.profile)}</span>
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
                      value={noteFor(finding.findingId)}
                      onChange={(event) => setNote(finding.findingId, event.target.value)}
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
