import type { NotificationSignals } from '../services/notifications.js';
import { useNotificationsViewModel } from '../viewmodels/useNotificationsViewModel.js';

// docs/08 → Bildirimler: zil menüsü + istenirse tarayıcı bildirimi.
// Görüldü işareti panelde lokal tutulur (localStorage).
export function NotificationBell({ signals }: { signals: NotificationSignals }) {
  // docs/09: View'da iş mantığı yasak — görüldü, duyurma ve izin ViewModel'de.
  const {
    notifications, unseen, open, toggleOpen, isSeen, markAllSeen, requestPermission,
  } = useNotificationsViewModel(signals);

  return (
    <div className="bell">
      <button
        type="button"
        className="bell__button"
        aria-label={`Bildirimler${unseen > 0 ? ` (${unseen} yeni)` : ''}`}
        aria-expanded={open}
        onClick={toggleOpen}
      >
        🔔
        {unseen > 0 ? <span className="bell__badge">{unseen}</span> : null}
      </button>

      {open ? (
        <div className="bell__menu" role="dialog" aria-label="Bildirim merkezi">
          <div className="bell__head">
            <strong>Bildirimler</strong>
            <span>
              <button type="button" onClick={requestPermission}>İzin ver</button>
              <button type="button" onClick={markAllSeen} disabled={unseen === 0}>
                Tümünü okundu say
              </button>
            </span>
          </div>

          {notifications.length === 0 ? (
            <p className="hint">Bekleyen bildirim yok.</p>
          ) : (
            <ul className="bell__list">
              {notifications.map((notification) => (
                <li
                  key={notification.id}
                  className={`bell__item bell__item--${notification.tone}${isSeen(notification.id) ? ' bell__item--seen' : ''}`}
                >
                  {/* Ton renkle gösterilir ama başlık her zaman yazılır. */}
                  <strong>{notification.title}</strong>
                  <span>{notification.detail}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
