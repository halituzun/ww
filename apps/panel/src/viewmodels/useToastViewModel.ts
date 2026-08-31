import { useState, useCallback, useMemo } from "react";

export type ToastType = "success" | "error" | "info" | "loading";

export interface ToastMessage {
  id: string;
  type: ToastType;
  title?: string;
  message: string;
  duration?: number;
}

export function useToastViewModel() {
  const [toasts, setToasts] = useState<readonly ToastMessage[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback((toast: Omit<ToastMessage, "id">) => {
    const id = Math.random().toString(36).slice(2, 9);
    const newToast: ToastMessage = { ...toast, id };
    setToasts((prev) => [...prev, newToast]);

    const duration = toast.duration ?? 4000;
    if (duration > 0) {
      setTimeout(() => {
        dismiss(id);
      }, duration);
    }
  }, [dismiss]);

  const success = useCallback((message: string, title?: string) => {
    showToast({ type: "success", message, ...(title === undefined ? {} : { title }) });
  }, [showToast]);

  const error = useCallback((message: string, title?: string) => {
    showToast({ type: "error", message, ...(title === undefined ? {} : { title }), duration: 6000 });
  }, [showToast]);

  const info = useCallback((message: string, title?: string) => {
    showToast({ type: "info", message, ...(title === undefined ? {} : { title }) });
  }, [showToast]);

  return {
    toasts,
    showToast,
    success,
    error,
    info,
    dismiss,
  };
}
