// Kontör özeti ve sağlayıcı sağlık rozetleri — SALT GÖRÜNÜM
// (docs/08 → API Yönetimi ve Kontör).
//
// NEDEN AYRI: ikisi de App.tsx içinde tek satırlık JSX yığınlarıydı
// (404 ve 360 karakter). Ayrılmadan test edilemiyorlardı; docs/09'un
// bileşen katmanı tam olarak bunun için var.
import { healthStatusLabel } from '../services/labels.js';
import type { ProviderHealth, Usage } from '../services/projects.js';

export function UsageMetrics({ usage }: { readonly usage: Usage | undefined }) {
  // Veri YOKKEN "0" yazmak yalandır: harcama sıfır değil, BİLİNMİYOR.
  if (usage === undefined) return null;

  return (
    <div className="metrics usage-metrics">
      <div><strong>${usage.costUsd.toFixed(4)}</strong><span>Maliyet</span></div>
      <div><strong>{usage.calls}</strong><span>Çağrı</span></div>
      <div>
        <strong>{usage.promptTokens + usage.completionTokens}</strong><span>Token</span>
      </div>
    </div>
  );
}

export function ProviderHealthBadges({ providers }: {
  readonly providers: readonly Pick<ProviderHealth, 'provider_id' | 'health_status'>[];
}) {
  if (providers.length === 0) return null;

  return (
    <div className="provider-health" aria-label="Sağlayıcı sağlığı">
      {providers.map((provider) => (
        <span
          key={provider.provider_id}
          className={`provider-badge provider-badge--${provider.health_status}`}
        >
          <i aria-hidden="true" />
          {provider.provider_id}: {healthStatusLabel(provider.health_status)}
        </span>
      ))}
    </div>
  );
}
