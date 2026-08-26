import { healthStatusLabel } from '../services/labels.js';
import { useProviders } from '../viewmodels/useProviders.js';
import { RoleModelTable } from './RoleModelTable.js';
import { CliproxyGatewayCard } from './CliproxyGatewayCard.js';
import { ProviderHealthBadges } from './UsageMetrics.js';

// API sağlayıcı yönetimi — docs/08-panel.md'de tanımlı bağımsız "API'ler" sayfası.
// Proje seçiminden bağımsızdır: sağlayıcılar proje-bağımsızdır (api_providers'ta
// project_id yoktur) ve ilk projeyi açabilmek için önce anahtar gerekir.
export function ProvidersPage() {
  const vm = useProviders();

  return (
    <section className="workspace-card providers-page" aria-label="API sağlayıcıları">
      <div className="section-heading">
        <div>
          <p className="eyebrow">MODEL ERİŞİMİ</p>
          <h2>AI gateway ve sağlayıcılar</h2>
        </div>
        <small>Hesaplarını gateway’den, doğrudan API anahtarlarını aşağıdan yönet.</small>
      </div>

      <ProviderHealthBadges providers={vm.providers} />
      <CliproxyGatewayCard />

      {vm.status ? <p className="provider-status" role="status">{vm.status}</p> : null}
      {vm.loading ? <p className="hint">Yükleniyor…</p> : null}

      {!vm.loading && vm.providers.length === 0 ? (
        <p className="hint">Kayıtlı sağlayıcı yok. Aşağıdaki formdan ekleyebilirsin.</p>
      ) : null}

      <ul className="provider-list">
        {vm.providers.map((provider) => (
          <li key={provider.provider_id} className="provider-card">
            <div className="provider-card__head">
              <strong>{provider.display_name}</strong>
              <code>{provider.provider_id}</code>
              <span className={`provider-badge provider-badge--${provider.health_status ?? 'unknown'}`}>
                {healthStatusLabel(provider.health_status ?? 'unknown')}
              </span>
              {provider.is_default ? <span className="pill">varsayılan</span> : null}
              {provider.enabled ? null : <span className="pill pill--paused">pasif</span>}
            </div>

            <dl className="provider-card__meta">
              <div><dt>Modeller</dt><dd>{provider.models.join(', ') || '—'}</dd></div>
              <div><dt>Fallback sırası</dt><dd>{provider.fallback_order}</dd></div>
              <div>
                <dt>Anahtar</dt>
                <dd>{provider.keyConfigured ? provider.maskedKey : 'girilmedi'}</dd>
              </div>
            </dl>

            <div className="provider-card__key">
              <label htmlFor={`key-${provider.provider_id}`}>
                {provider.keyConfigured ? 'Anahtarı değiştir' : 'API anahtarı gir'}
              </label>
              <input
                id={`key-${provider.provider_id}`}
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="sk-…"
                value={vm.keyInputs[provider.provider_id] ?? ''}
                onChange={(event) => vm.setKeyInput(provider.provider_id, event.target.value)}
              />
              <button type="button" onClick={() => void vm.submitKey(provider.provider_id)}>
                Kaydet
              </button>
            </div>
          </li>
        ))}
      </ul>

      <RoleModelTable providers={vm.providers} />

      <details className="provider-advanced">
        <summary>Doğrudan API sağlayıcısı ekle veya düzenle</summary>
      <form
        className="provider-create"
        onSubmit={(event) => { event.preventDefault(); void vm.submitDraft(); }}
      >
        <h3>Yeni sağlayıcı</h3>
        <div className="provider-create__grid">
          <input aria-label="Sağlayıcı kimliği" placeholder="kimlik (ör. openai)"
            value={vm.draft.id}
            onChange={(event) => vm.setDraft({ ...vm.draft, id: event.target.value })} />
          <input aria-label="Görünen ad" placeholder="görünen ad"
            value={vm.draft.displayName}
            onChange={(event) => vm.setDraft({ ...vm.draft, displayName: event.target.value })} />
          <input aria-label="Base URL" placeholder="base URL (boş bırakılabilir)"
            value={vm.draft.baseUrl}
            onChange={(event) => vm.setDraft({ ...vm.draft, baseUrl: event.target.value })} />
          <input aria-label="Modeller" placeholder="modeller (virgülle)"
            value={vm.draft.models}
            onChange={(event) => vm.setDraft({ ...vm.draft, models: event.target.value })} />
          <input aria-label="Fallback sırası" type="number" min={0} max={255}
            value={vm.draft.fallbackOrder}
            onChange={(event) => vm.setDraft({ ...vm.draft, fallbackOrder: event.target.value })} />
        </div>
        <button type="submit">Sağlayıcı ekle</button>
      </form>
      </details>
    </section>
  );
}
