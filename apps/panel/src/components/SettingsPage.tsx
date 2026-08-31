import React from "react";
import { useSettingsViewModel } from "../viewmodels/useSettingsViewModel.js";

const cliproxyLabels: Record<string, string> = {
  not_configured: "Bağlanmadı",
  unreachable: "Ulaşılamıyor",
  unauthorized: "Yönetim anahtarı gerekli",
  connected: "Bağlı",
};

export function SettingsPage() {
  const {
    health,
    cliproxyStatus,
    tokenInput,
    setTokenInput,
    validateToken,
    validating,
    tokenValidationResult,
    soundEnabled,
    toggleSound,
    desktopNotifEnabled,
    toggleDesktopNotif,
  } = useSettingsViewModel();

  const cliproxyState = cliproxyStatus?.state ?? "unreachable";
  const cliproxyOk = cliproxyState === "connected";
  const h = health.health;

  const services = [
    {
      name: "ClickHouse Veritabanı",
      detail: "Vektör & Olay Belleği",
      status: !h ? "Bilinmiyor" : h.clickhouse ? "Bağlı" : "Ulaşılamıyor",
      ok: Boolean(h?.clickhouse),
    },
    {
      name: "Redis Önbellek",
      detail: "Olay Yayın & Oturum",
      status: !h ? "Bilinmiyor" : h.redis ? "Bağlı" : "Ulaşılamıyor",
      ok: Boolean(h?.redis),
    },
    {
      name: "WW API Sunucusu",
      detail: "Orkestrasyon Motoru",
      status: !h ? "Bilinmiyor" : h.ok ? "Bağlı" : "Ulaşılamıyor",
      ok: Boolean(h?.ok),
    },
    {
      name: "CLIProxyAPI Gateway",
      detail: "Model Gateway",
      status: cliproxyLabels[cliproxyState] ?? cliproxyState,
      ok: cliproxyOk,
    },
  ];

  return (
    <div className="settings-page">
      <div className="settings-header">
        <h2>Sistem Ayarları & Entegrasyonlar</h2>
        <p className="hint">Altyapı servisleri, oturum token doğrulama ve kullanıcı tercihleri.</p>
      </div>

      <div className="settings-grid">
        <div className="card settings-card">
          <h3>Altyapı Servisleri Bağlantı Durumu</h3>
          <div className="services-status-list">
            {services.map((s) => (
              <div key={s.name} className="service-status-row">
                <div className="service-info">
                  <strong>{s.name}</strong>
                  <small className="mono-address">{s.detail}</small>
                </div>
                <span className={`pill ${s.ok ? "pill--running" : "pill--failed"}`}>
                  {s.status}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="card settings-card">
          <h3>Oturum Token'ı Doğrulama</h3>
          <p className="hint">Yönetim erişimi ve API anahtarı oturum geçerliliğini test edin:</p>
          <div className="command-row">
            <input
              type="password"
              aria-label="Oturum tokenı"
              placeholder="Oturum token'ı (Bearer...)"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              autoComplete="off"
            />
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void validateToken()}
              disabled={validating}
            >
              {validating ? "Test Ediliyor…" : "Doğrula"}
            </button>
          </div>
          {tokenValidationResult ? (
            <p className="hint hint--status" role="status">{tokenValidationResult}</p>
          ) : null}
        </div>

        <div className="card settings-card">
          <h3>Bildirim & Ses Tercihleri</h3>
          <div className="toggles-list">
            <label className="toggle-row">
              <span>Masaüstü Bildirimleri</span>
              <input
                type="checkbox"
                aria-label="Masaüstü bildirimleri"
                checked={desktopNotifEnabled}
                onChange={toggleDesktopNotif}
              />
            </label>
            <label className="toggle-row">
              <span>Sesli Uyarılar (Hata ve Tırmandırma)</span>
              <input
                type="checkbox"
                aria-label="Sesli uyarılar"
                checked={soundEnabled}
                onChange={toggleSound}
              />
            </label>
          </div>
        </div>

        <div className="card settings-card">
          <h3>Klavye Kısayolları (Aktif)</h3>
          <div className="shortcuts-table">
            <div className="shortcut-row">
              <span>Komut Paletini Aç</span>
              <kbd>⌘K</kbd>
            </div>
            <div className="shortcut-row">
              <span>Genel Bakış Sayfası</span>
              <kbd>G + O</kbd>
            </div>
            <div className="shortcut-row">
              <span>Görevler Sayfası</span>
              <kbd>G + G</kbd>
            </div>
            <div className="shortcut-row">
              <span>PM & Agent Sohbeti</span>
              <kbd>G + S</kbd>
            </div>
            <div className="shortcut-row">
              <span>Dosyalar & Fihrist</span>
              <kbd>G + D</kbd>
            </div>
            <div className="shortcut-row">
              <span>Projeler Listesi</span>
              <kbd>G + P</kbd>
            </div>
            <div className="shortcut-row">
              <span>Kontör & Bütçe</span>
              <kbd>G + B</kbd>
            </div>
            <div className="shortcut-row">
              <span>Denetim Raporu</span>
              <kbd>G + A</kbd>
            </div>
            <div className="shortcut-row">
              <span>API Sağlayıcıları</span>
              <kbd>G + M</kbd>
            </div>
            <div className="shortcut-row">
              <span>Ayarlar</span>
              <kbd>G + ,</kbd>
            </div>
            <div className="shortcut-row">
              <span>Açılır Pencereleri / Çekmeceleri Kapat</span>
              <kbd>Esc</kbd>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
