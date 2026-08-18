// Emülatör/cihaz önizlemesi — SALT GÖRÜNÜM (docs/10 → "ekran akışı panelde
// görünür"; docs/11 Faz 6).
//
// NEDEN VAR: sunucu uçları hazırdı ama panel onları hiç çağırmıyordu.
import {
  useMobilePreviewViewModel, type MobilePreviewPorts,
} from '../viewmodels/useMobilePreviewViewModel.js';
import { deviceTapPoint } from '../viewmodels/tap-coordinates.js';

export function MobilePreviewPanel({ ports }: { readonly ports?: MobilePreviewPorts }) {
  const vm = useMobilePreviewViewModel(ports);
  const choices = [...vm.targets.devices, ...vm.targets.avds];

  return (
    <section className="mobile-preview" aria-label="Cihaz önizleme">
      <div className="section-heading">
        <h3>Cihaz önizleme</h3>
        <small>Bağlı cihaz ya da başlatılabilir AVD</small>
      </div>

      {/* Sunucu hedef bulamadığında SEBEBİYLE 503 döner; o sebep gösterilir
          ki kullanıcı neyi kuracağını bilsin. */}
      {vm.error === '' ? null : <p className="audit-error" role="alert">{vm.error}</p>}

      {vm.sessionId === '' ? (
        choices.length === 0 ? (
          // Boş durum: hata yoksa gerçekten hedef yok demektir.
          vm.error === '' ? <p className="hint">Bağlı cihaz ya da AVD bulunamadı.</p> : null
        ) : (
          <ul className="task-list">
            {choices.map((target) => (
              <li key={target}>
                <code>{target}</code>
                <button type="button" disabled={vm.busy} onClick={() => void vm.open(target)}>
                  Aç
                </button>
              </li>
            ))}
          </ul>
        )
      ) : (
        <>
          <div className="command-row">
            <strong>oturum · {vm.sessionId}</strong>
            <button type="button" disabled={vm.busy} onClick={() => void vm.stop()}>Durdur</button>
          </div>
          {vm.frameDataUrl === '' ? (
            <p className="hint">Kare bekleniyor…</p>
          ) : (
            // Ekran görüntüsü ALT metinle verilir: görsel tek başına bilgi
            // taşımaz (docs/09 ui_audit).
            <img
              className="mobile-frame"
              src={vm.frameDataUrl}
              alt="Cihaz ekranı"
              onClick={(clickEvent) => {
                const image = clickEvent.currentTarget;
                const point = deviceTapPoint(
                  { clientX: clickEvent.clientX, clientY: clickEvent.clientY },
                  image.getBoundingClientRect(),
                  { width: image.naturalWidth, height: image.naturalHeight },
                );
                // Nokta hesaplanamıyorsa (görüntü yüklenmedi) DOKUNULMAZ:
                // NaN koordinat adb'de sessizce düşer.
                if (point !== undefined) void vm.tap(point);
              }}
            />
          )}
        </>
      )}
    </section>
  );
}
