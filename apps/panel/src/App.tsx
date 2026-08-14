import { useHealth } from './viewmodels/useHealth.js';

export default function App() {
  const { health, state, status } = useHealth();

  return (
    <main className="shell">
      <p className="eyebrow">ww</p>
      <h1>ww paneli — Faz 3'te gelecek</h1>
      <p className="intro">Agent çalışma alanının görsel yönetim katmanı hazırlanıyor.</p>

      <section className={`status-card status-card--${state}`} aria-live="polite">
        <div>
          <p className="status-label">Altyapı durumu</p>
          <h2>{status}</h2>
        </div>
        <span className="status-dot" aria-hidden="true" />

        {health ? (
          <dl>
            <div>
              <dt>ClickHouse</dt>
              <dd>{health.clickhouse ? 'Çalışıyor' : 'Kapalı'}</dd>
            </div>
            <div>
              <dt>Redis</dt>
              <dd>{health.redis ? 'Çalışıyor' : 'Kapalı'}</dd>
            </div>
          </dl>
        ) : null}
      </section>
    </main>
  );
}
