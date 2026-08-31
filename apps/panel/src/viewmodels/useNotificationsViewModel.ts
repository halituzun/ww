// docs/09 → View → ViewModel → Service.
//
// NEDEN VAR: NotificationBell görüldü-durumunu, localStorage yazımını ve
// tarayıcı bildirimi yan etkisini kendi içinde tutuyordu. Bunlar iş
// mantığıdır ve View'da test edilemez; bildirim gürültüsü kuralı
// ("yalnız kritik ve daha önce duyurulmamış") tam da sessizce bozulabilecek
// türden bir kuraldır.
import { useEffect, useRef, useState, useCallback } from 'react';
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
  readonly containerRef: React.RefObject<HTMLDivElement | null>;
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
  const containerRef = useRef<HTMLDivElement>(null);

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

  const close = useCallback(() => setOpen(false), []);

  const toggleOpen = useCallback(() => {
    setOpen((current) => {
      const next = !current;
      if (next && typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("ww-popover-open", { detail: "notifications" }));
      }
      return next;
    });
  }, []);

  // Karşılıklı dışlama ve sayfa değişimi
  useEffect(() => {
    function handleOtherPopover(e: Event) {
      const customEvent = e as CustomEvent<string>;
      if (customEvent.detail !== "notifications") {
        close();
      }
    }
    function handleHashChange() {
      close();
    }
    if (typeof window !== "undefined") {
      window.addEventListener("ww-popover-open", handleOtherPopover);
      window.addEventListener("hashchange", handleHashChange);
    }
    return () => {
      if (typeof window !== "undefined") {
        window.removeEventListener("ww-popover-open", handleOtherPopover);
        window.removeEventListener("hashchange", handleHashChange);
      }
    };
  }, [close]);

  // Dışarı tıklama ve Escape
  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        close();
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        close();
      }
    }
    if (typeof window !== "undefined") {
      window.addEventListener("mousedown", handleClickOutside);
      window.addEventListener("keydown", handleKeyDown);
    }
    return () => {
      if (typeof window !== "undefined") {
        window.removeEventListener("mousedown", handleClickOutside);
        window.removeEventListener("keydown", handleKeyDown);
      }
    };
  }, [open, close]);

  return {
    notifications,
    unseen,
    open,
    containerRef,
    setOpen,
    toggleOpen,
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
