import {
  budgetTone,
  formatUsd,
} from '../services/budget.js';
import { useBudgetViewModel } from '../viewmodels/useBudgetViewModel.js';

// Kategorik palet: dataviz referans paletinin koyu sütunu, panelin yüzeyine
// (#0b1220) karşı validate_palette.js ile doğrulandı — 5 kontrolün beşi PASS.
// Sıra sabittir ve asla döngüye sokulmaz; 6. seri "Diğer"e katlanır.
const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181'] as const;
const MAX_SERIES = SERIES.length;

const pct = (value: number): string => `${Math.min(100, Math.max(0, value * 100)).toFixed(0)}%`;

export function BudgetPanel({ projectId }: { projectId: string }) {
  // docs/09: View'da fetch yasak — yükleme ve yoklama ViewModel'de.
  const {
    report, limitDraft, setLimitDraft, limitNote, limitError, saving, saveLimit,
  } = useBudgetViewModel(projectId);

  const { totals, budget } = report;
  const tone = budgetTone(budget.state);
  const maxDaily = Math.max(1, ...report.daily.map((point) => point.costUsd));

  // docs/08 "pasta" diyor; yatay çubuk tercih edildi: küçük dilimlerin
  // karşılaştırılması pastada güvenilmezdir, çubukta ortak bir tabana oturur.
  const slices = report.byModel.slice(0, MAX_SERIES);
  const otherCost = report.byModel.slice(MAX_SERIES)
    .reduce((sum, slice) => sum + slice.costUsd, 0);
  const maxSlice = Math.max(1, ...slices.map((slice) => slice.costUsd), otherCost);

  return (
    <section className="budget-panel" aria-label="Kontör panosu">
      <div className="section-heading">
        <h3>Kontör</h3>
        <small>Son {report.windowDays} gün</small>
      </div>

      {/* Tek başlık sayı: grafik değil, stat tile doğru form. */}
      {/* docs/08: "bütçe düzenleme". Limit yalnızca proje oluşturulurken
          verilebiliyordu; sınırsız açılmış projeye fren kurulamıyordu. */}
      <div className="budget-limit">
        <label>
          Bütçe limiti (USD, 0 = sınırsız)
          <input
            aria-label="Bütçe limiti"
            value={limitDraft}
            placeholder={String(report.budget.limitUsd)}
            onChange={(event) => setLimitDraft(event.target.value)}
          />
        </label>
        <button type="button" disabled={saving} onClick={() => void saveLimit()}>Kaydet</button>
      </div>
      {limitError !== '' ? <p className="budget-limit__error">{limitError}</p> : null}
      {limitNote !== '' ? <p className="hint">{limitNote}</p> : null}

      <div className="budget-tiles">
        <div className="budget-tile budget-tile--hero">
          <strong>{formatUsd(totals.costUsd)}</strong>
          <span>Toplam maliyet</span>
        </div>
        <div className="budget-tile"><strong>{totals.calls}</strong><span>Çağrı</span></div>
        <div className="budget-tile">
          <strong>{(totals.promptTokens + totals.completionTokens).toLocaleString('tr-TR')}</strong>
          <span>Token</span>
        </div>
        <div className={`budget-tile${totals.errors > 0 ? ' budget-tile--attention' : ''}`}>
          <strong>{totals.errors}</strong><span>Hatalı çağrı</span>
        </div>
      </div>

      {/* Bütçe ölçeri: durum rengi + metin birlikte; renk tek başına anlam taşımaz. */}
      <div className={`budget-meter budget-meter--${tone.tone}`}>
        <div className="budget-meter__label">
          <span>{tone.label}</span>
          <span>
            {budget.limitUsd > 0
              ? `${formatUsd(budget.spentUsd)} / ${formatUsd(budget.limitUsd)}`
              : formatUsd(budget.spentUsd)}
          </span>
        </div>
        {budget.limitUsd > 0 ? (
          <div
            className="budget-meter__track"
            role="meter"
            aria-valuenow={Math.round(budget.ratio * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Bütçe kullanımı"
          >
            <div className="budget-meter__fill" style={{ width: pct(budget.ratio) }} />
            {/* docs/08: %80 uyarı çizgisi */}
            <div className="budget-meter__threshold" style={{ left: '80%' }} aria-hidden="true" />
          </div>
        ) : null}
      </div>

      {report.daily.length > 0 ? (
        <div className="budget-block">
          <h4>Günlük maliyet</h4>
          <ul className="budget-bars budget-bars--time">
            {report.daily.map((point) => (
              <li key={point.day} title={`${point.day}: ${formatUsd(point.costUsd)} · ${point.calls} çağrı`}>
                <span className="budget-bars__mark" style={{ height: pct(point.costUsd / maxDaily) }} />
                <span className="budget-bars__caption">{point.day.slice(5)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {slices.length > 0 ? (
        <div className="budget-block">
          <h4>Sağlayıcı / model kırılımı</h4>
          <ul className="budget-breakdown">
            {slices.map((slice, index) => (
              <li key={`${slice.providerId}:${slice.model}`}>
                <span className="budget-breakdown__key">
                  <span className="budget-breakdown__swatch" style={{ background: SERIES[index] }} aria-hidden="true" />
                  {slice.providerId}:{slice.model}
                </span>
                <span className="budget-breakdown__track">
                  <span
                    className="budget-breakdown__fill"
                    style={{ width: pct(slice.costUsd / maxSlice), background: SERIES[index] }}
                  />
                </span>
                <span className="budget-breakdown__value">{formatUsd(slice.costUsd)}</span>
              </li>
            ))}
            {otherCost > 0 ? (
              <li>
                <span className="budget-breakdown__key">
                  <span className="budget-breakdown__swatch budget-breakdown__swatch--other" aria-hidden="true" />
                  Diğer
                </span>
                <span className="budget-breakdown__track">
                  <span className="budget-breakdown__fill budget-breakdown__fill--other"
                    style={{ width: pct(otherCost / maxSlice) }} />
                </span>
                <span className="budget-breakdown__value">{formatUsd(otherCost)}</span>
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}

      {report.topTasks.length > 0 ? (
        <div className="budget-block">
          <h4>En pahalı görevler</h4>
          <ol className="budget-tasks">
            {report.topTasks.map((task) => (
              <li key={task.taskId}>
                <code>{task.taskId.slice(0, 8)}</code>
                <span>{formatUsd(task.costUsd)}</span>
                <small>{task.calls} çağrı</small>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {totals.calls === 0 ? (
        <p className="hint">Henüz API çağrısı yok — sağlayıcı anahtarı girilince burası dolacak.</p>
      ) : null}
    </section>
  );
}
