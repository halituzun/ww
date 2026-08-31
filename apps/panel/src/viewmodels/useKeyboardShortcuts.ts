import { useEffect, useRef } from "react";
import type { PageId } from "../services/routes.js";

export function useKeyboardShortcuts({
  onNavigate,
  onCloseModals,
}: {
  readonly onNavigate: (page: PageId) => void;
  readonly onCloseModals?: () => void;
}) {
  const gPressedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const isInput =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);

      if (e.key === "Escape") {
        onCloseModals?.();
        return;
      }

      if (isInput || e.metaKey || e.ctrlKey || e.altKey) {
        return;
      }

      const key = e.key.toLowerCase();

      if (key === "g") {
        gPressedRef.current = true;
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          gPressedRef.current = false;
        }, 1200);
        return;
      }

      if (gPressedRef.current) {
        gPressedRef.current = false;
        if (timerRef.current) clearTimeout(timerRef.current);

        switch (key) {
          case "p":
            e.preventDefault();
            onNavigate("projects");
            break;
          case "o":
            e.preventDefault();
            onNavigate("overview");
            break;
          case "t":
            e.preventDefault();
            onNavigate("canvas");
            break;
          case "k":
          case "g":
            e.preventDefault();
            onNavigate("tasks");
            break;
          case "d":
            e.preventDefault();
            onNavigate("files");
            break;
          case "s":
            e.preventDefault();
            onNavigate("chat");
            break;
          case "b":
            e.preventDefault();
            onNavigate("budget");
            break;
          case "a":
            e.preventDefault();
            onNavigate("audit");
            break;
          case "m":
            e.preventDefault();
            onNavigate("providers");
            break;
          case "y":
          case ",":
            e.preventDefault();
            onNavigate("settings");
            break;
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [onNavigate, onCloseModals]);
}
