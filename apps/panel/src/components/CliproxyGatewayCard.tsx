import { useCliproxyGateway } from '../viewmodels/useCliproxyGateway.js';

const labels = {
  not_configured: 'Bağlanmadı',
  unreachable: 'Ulaşılamıyor',
  unauthorized: 'Yönetim anahtarı gerekli',
  connected: 'Bağlı',
} as const;

export function CliproxyGatewayCard() {
  const vm = useCliproxyGateway();
  const status = vm.status;
  const state = status?.state ?? 'unreachable';
  return (
    <section className="gateway-card" aria-label="CLIProxyAPI gateway">
      <div className="gateway-card__header">
        <div>
          <p className="eyebrow">AI GATEWAY</p>
          <h2>CLIProxyAPI</h2>
          <p className="gateway-card__copy">Codex, Claude, Gemini ve diğer hesaplarını tek gateway üzerinden yönlendir.</p>
        </div>
        <span className={`gateway-state gateway-state--${state}`}><i aria-hidden="true" />{labels[state]}</span>
      </div>
      {vm.loading ? <p className="hint">Gateway kontrol ediliyor…</p> : null}
      {vm.error ? <p className="audit-error" role="alert">{vm.error}</p> : null}
      {status ? (
        <div className="gateway-card__details">
          <div><span>Endpoint</span><code>{status.baseUrl}/v1</code></div>
          <div><span>Hesap/API anahtarı</span><strong>{status.accountCount ?? '—'}</strong></div>
          <div><span>Model eşlemesi</span><strong>{status.modelCount ?? '—'}</strong></div>
        </div>
      ) : null}
      <div className="gateway-card__actions">
        <a href={status?.managementUrl ?? 'http://127.0.0.1:8317/management.html'} target="_blank" rel="noreferrer">Gateway yönetimini aç</a>
        <button type="button" onClick={() => void vm.reload()}>Durumu yenile</button>
      </div>
      {state === 'not_configured' ? <small className="gateway-card__hint">Server için WW_CLIPROXY_ENABLED=1 ve yönetim anahtarı ayarlanmalı.</small> : null}
    </section>
  );
}
