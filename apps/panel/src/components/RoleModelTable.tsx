export type RoleTier = 'heavy' | 'medium' | 'light';

export const ROLE_TIERS: Record<string, { tier: RoleTier; label: string; tone: string }> = {
  pm: { tier: 'heavy', label: 'Ağır', tone: 'heavy' },
  council_member: { tier: 'heavy', label: 'Ağır', tone: 'heavy' },
  professor: { tier: 'heavy', label: 'Ağır', tone: 'heavy' },
  standards_auditor: { tier: 'heavy', label: 'Ağır', tone: 'heavy' },
  group_lead: { tier: 'medium', label: 'Orta', tone: 'medium' },
  worker: { tier: 'medium', label: 'Orta', tone: 'medium' },
  verifier: { tier: 'medium', label: 'Orta', tone: 'medium' },
  interviewer: { tier: 'medium', label: 'Orta', tone: 'medium' },
  researcher: { tier: 'medium', label: 'Orta', tone: 'medium' },
  creator: { tier: 'medium', label: 'Orta', tone: 'medium' },
  summarizer: { tier: 'light', label: 'Hafif', tone: 'light' },
  narrator: { tier: 'light', label: 'Hafif', tone: 'light' },
};
import { useRoleModels } from '../viewmodels/useRoleModels.js';
import type { Provider } from '../services/providers.js';
import { crossCheckWarnings } from '../services/role-models.js';

// docs/08 → API Yönetimi: rol, birincil model, yedekler tablosu.
// Model önerileri kayıtlı sağlayıcıların models listesinden türetilir.
export function RoleModelTable({ providers }: { providers: readonly Provider[] }) {
  const vm = useRoleModels();

  const suggestions = providers.flatMap((provider) =>
    provider.models.map((model) => `${provider.provider_id}:${model}`));
  const warnings = crossCheckWarnings(vm.rows);

  return (
    <section className="role-models" aria-label="Rol model eşlemesi">
      <div className="section-heading">
        <h3>Rol → model eşlemesi</h3>
        <small>Hangi rolün hangi modelle çalışacağı; yedekler virgülle ayrılır.</small>
      </div>

      {vm.status ? <p className="provider-status" role="status">{vm.status}</p> : null}
      {warnings.map((warning) => (
        <p key={warning} className="role-warning" role="note"> {warning}</p>
      ))}
      {vm.loading ? <p className="hint">Yükleniyor…</p> : null}
      {/* Boş tablo "hiç rol eşlemesi yok" gibi okunur; yükleme hatası
          AÇIKÇA söylenir ki kullanıcı var olan eşlemelerini yeniden
          kurmaya kalkmasın. */}
      {vm.loadError === '' ? null : (
        <p className="audit-error" role="alert">{vm.loadError}</p>
      )}

      <datalist id="model-suggestions">
        {suggestions.map((ref) => <option key={ref} value={ref} />)}
      </datalist>

      <table className="role-model-table">
        <thead>
          <tr>
            <th scope="col">Rol</th>
            <th scope="col">Katman</th>
            <th scope="col">Birincil model</th>
            <th scope="col">Yedekler</th>
            <th scope="col"><span className="visually-hidden">İşlem</span></th>
          </tr>
        </thead>
        <tbody>
          {vm.rows.map((row) => {
            const draft = vm.drafts[row.role] ?? { modelRef: '', fallbackRefs: '' };
            const dirty = draft.modelRef !== row.modelRef
              || draft.fallbackRefs !== row.fallbackRefs.join(', ');
            return (
              <tr key={row.role} className={row.configured ? '' : 'role-row--unset'}>
                <th scope="row">
                  {row.role}
                  {row.configured ? null : <span className="pill pill--paused">eşlenmedi</span>}
                </th>
                <td>
                  {ROLE_TIERS[row.role] !== undefined ? (
                    <span className={`role-tier-badge role-tier-badge--${ROLE_TIERS[row.role]!.tone}`}>
                      {ROLE_TIERS[row.role]!.label}
                    </span>
                  ) : null}
                </td>
                <td>
                  <input
                    aria-label={`${row.role} birincil model`}
                    list="model-suggestions"
                    placeholder="provider:model"
                    value={draft.modelRef}
                    onChange={(event) => vm.setDraft(row.role, { ...draft, modelRef: event.target.value })}
                  />
                </td>
                <td>
                  <input
                    aria-label={`${row.role} yedek modeller`}
                    placeholder="provider:model, provider:model"
                    value={draft.fallbackRefs}
                    onChange={(event) => vm.setDraft(row.role, { ...draft, fallbackRefs: event.target.value })}
                  />
                </td>
                <td>
                  <button type="button" disabled={!dirty} onClick={() => void vm.submit(row.role)}>
                    Kaydet
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
