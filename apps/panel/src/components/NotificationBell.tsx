import { useEffect, useRef, useState } from 'react';
import {
  deriveNotifications,
  loadSeen,
  saveSeen,
  unseenCount,
  type NotificationSignals,
  type PanelNotification,
} from '../services/notifications.js';

// docs/08 → Bildirimler: zil menüsü + istenirse tarayıcı bildirimi.
// Görüldü işareti panelde lokal tutulur (localStorage).
export function NotificationBell({ signals }: { signals: NotificationSignals }) {
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState<Set<string>>(() => loadSeen());
  const alerted = useRef<Set<string>>(new Set());

  const notifications = deriveNotifications(signals);
  const unseen = unseenCount(notifications, seen);

  // Tarayıcı bildirimi YALNIZ kritik ve daha önce duyurulmamış olanlar için;
  // eskiden her WebSocket olayı bildirim atıyordu ve gürültüden okunmuyordu.
  useEffect(() => {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    for (const notification of notifications) {
      if (notification.tone !== 'critical') continue;
      if (alerted.current.has(notification.id) || seen.has(notification.id)) continue;
      alerted.current.add(notification.id);
      new Notification(`ww · ${notification.title}`, { body: notification.detail });
    }
  }, [notifications, seen]);

  const markAllSeen = () => {
    const next = new Set(notifications.map((notification) => notification.id));
    setSeen(next);
    saveSeen(next);
  };

  const requestPermission = () => {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      void Notification.requestPermission();
    }
  };

  return (
    <div className="bell">
      <button
        type="button"
        className="bell__button"
        aria-label={`Bildirimler${unseen > 0 ? ` (${unseen} yeni)` : ''}`}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
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
              {notifications.map((notification: PanelNotification) => (
                <li
                  key={notification.id}
                  className={`bell__item bell__item--${notification.tone}${seen.has(notification.id) ? ' bell__item--seen' : ''}`}
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
