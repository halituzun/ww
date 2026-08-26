import type { NotificationSignals } from "../services/notifications.js";
import { useNotificationsViewModel } from "../viewmodels/useNotificationsViewModel.js";

export function NotificationBell({ signals }: { signals: NotificationSignals }) {
  const {
    notifications, unseen, open, toggleOpen, isSeen, markAllSeen, requestPermission, containerRef,
  } = useNotificationsViewModel(signals);

  return (
    <div className="bell" ref={containerRef}>
      <button
        type="button"
        className="bell__button"
        aria-label={`Bildirimler${unseen > 0 ? ` (${unseen} yeni)` : ""}`}
        aria-expanded={open}
        onClick={toggleOpen}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M4 6.5a4 4 0 018 0v3l1.25 2H2.75L4 9.5z" />
          <path d="M6.5 11.5a1.5 1.5 0 003 0" />
        </svg>
        {unseen > 0 ? <span className="bell__badge">{unseen}</span> : null}
      </button>

      {open ? (
        <div className="bell__menu" role="dialog" aria-label="Bildirim merkezi">
          <div className="bell__head">
            <strong>Bildirimler</strong>
            <div className="bell__actions">
              <button type="button" className="linklike" onClick={requestPermission}>İzin ver</button>
              <button type="button" className="linklike" onClick={markAllSeen} disabled={unseen === 0}>
                Tümünü okundu say
              </button>
            </div>
          </div>

          {notifications.length === 0 ? (
            <p className="hint">Bekleyen bildirim yok.</p>
          ) : (
            <ul className="bell__list">
              {notifications.map((notification) => (
                <li
                  key={notification.id}
                  className={`bell__item bell__item--${notification.tone}${isSeen(notification.id) ? " bell__item--seen" : ""}`}
                >
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
