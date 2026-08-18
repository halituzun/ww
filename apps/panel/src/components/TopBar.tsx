// Üst şerit — SALT GÖRÜNÜM (docs/08 genel yerleşim).
//
// NEDEN AYRI: App.tsx içinde TEK SATIRDA 718 karakterdi ve iki sayfada
// (çalışma alanı / sağlayıcılar) elle kopyalanmıştı — biri değiştiğinde
// diğeri sessizce geride kalırdı.
import type { ReactNode } from 'react';
import { connectionLabel, type ConnectionState } from '../viewmodels/live-connection.js';

export function TopBar({
  title, connection, projectId, onProjectId, onProviders, onBack, children,
}: {
  readonly title: string;
  /** Canlı olay bağlantısı; verilmezse rozet çizilmez. */
  readonly connection?: ConnectionState;
  readonly projectId?: string;
  readonly onProjectId?: (next: string) => void;
  readonly onProviders?: () => void;
  readonly onBack?: () => void;
  /** Bildirim zili gibi ek eylemler. */
  readonly children?: ReactNode;
}) {
  return (
    <header className="topbar">
      <div>
        <p className="eyebrow">ww / ORCHESTRATION</p>
        <h1>{title}</h1>
      </div>
      <div className="topbar-actions">
        {connection === undefined ? null : (
          <span className={`conn conn--${connection}`} title="Canlı olay bağlantısı">
            <span className="conn__dot" aria-hidden="true" />
            {connectionLabel(connection)}
          </span>
        )}
        {onBack === undefined ? null : (
          <button type="button" onClick={onBack}>← Çalışma alanı</button>
        )}
        {onProviders === undefined ? null : (
          <button type="button" onClick={onProviders}>API&apos;ler</button>
        )}
        {children}
        {onProjectId === undefined ? null : (
          <input
            aria-label="Proje kimliği"
            placeholder="Proje UUID"
            value={projectId ?? ''}
            onChange={(event) => onProjectId(event.target.value)}
          />
        )}
      </div>
    </header>
  );
}
