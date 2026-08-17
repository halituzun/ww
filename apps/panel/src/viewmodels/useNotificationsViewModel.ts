// docs/09 → View → ViewModel → Service.
//
// NEDEN VAR: NotificationBell görüldü-durumunu, localStorage yazımını ve
// tarayıcı bildirimi yan etkisini kendi içinde tutuyordu. Bunlar iş
// mantığıdır ve View'da test edilemez; bildirim gürültüsü kuralı
// ("yalnız kritik ve daha önce duyurulmamış") tam da sessizce bozulabilecek
// türden bir kuraldır.
import { useEffect, useRef, useState } from 'react';
import {
  deriveNotifications,
  loadSeen,
  saveSeen,
  unseenCount,
  type NotificationSignals,
  type PanelNotification,
} from '../services/notifications.js';

export interface NotificationsViewModelPorts {
  /** Kritik bildirimi duyuran yan etki; testte ve izin yokken devre dışıdır. */
  announce?: (notification: PanelNotification) => void;
  loadSeenIds?: typeof loadSeen;
  saveSeenIds?: typeof saveSeen;
}

export interface NotificationsViewModel {
  readonly notifications: readonly PanelNotification[];
  readonly unseen: number;
  readonly open: boolean;
  setOpen(open: boolean): void;
  toggleOpen(): void;
  /** View, görüldü kümesini görmez; yalnız tek tek sorar. */
  isSeen(notificationId: string): boolean;
  markAllSeen(): void;
  requestPermission(): void;
}

/** İzin verilmişse gerçek tarayıcı bildirimi; yoksa sessiz kalır. */
function browserAnnounce(notification: PanelNotification): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  new Notification(`ww · ${notification.title}`, { body: notification.detail });
}

export function useNotificationsViewModel(
  signals: NotificationSignals,
  ports: NotificationsViewModelPorts = {},
): NotificationsViewModel {
  const announce = ports.announce ?? browserAnnounce;
  const readSeen = ports.loadSeenIds ?? loadSeen;
  const writeSeen = ports.saveSeenIds ?? saveSeen;

  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState<Set<string>>(() => readSeen());
  const alerted = useRef<Set<string>>(new Set());

  const notifications = deriveNotifications(signals);
  const unseen = unseenCount(notifications, seen);

  // YALNIZ kritik ve daha önce duyurulmamış olanlar duyurulur; eskiden her
  // olay bildirim atıyordu ve gürültüden hiçbiri okunmuyordu.
  useEffect(() => {
    for (const notification of notifications) {
      if (notification.tone !== 'critical') continue;
      if (alerted.current.has(notification.id) || seen.has(notification.id)) continue;
      alerted.current.add(notification.id);
      announce(notification);
    }
  }, [notifications, seen, announce]);

  return {
    notifications,
    unseen,
    open,
    setOpen,
    toggleOpen: () => setOpen((current) => !current),
    isSeen: (notificationId) => seen.has(notificationId),
    markAllSeen: () => {
      const next = new Set(notifications.map((notification) => notification.id));
      setSeen(next);
      writeSeen(next);
    },
    requestPermission: () => {
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        void Notification.requestPermission();
      }
    },
  };
}
