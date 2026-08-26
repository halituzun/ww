import React, { createContext, useContext, useMemo } from "react";
import { useToastViewModel, type ToastType, type ToastMessage } from "../viewmodels/useToastViewModel.js";

interface ToastContextType {
  showToast: (toast: Omit<ToastMessage, "id">) => void;
  success: (message: string, title?: string) => void;
  error: (message: string, title?: string) => void;
  info: (message: string, title?: string) => void;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextType | null>(null);

export function useToast(): ToastContextType {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    return {
      showToast: () => {},
      success: () => {},
      error: () => {},
      info: () => {},
      dismiss: () => {},
    };
  }
  return ctx;
}

export function ToastProvider({ children }: { readonly children: React.ReactNode }) {
  const vm = useToastViewModel();
  const value = useMemo(
    () => ({
      showToast: vm.showToast,
      success: vm.success,
      error: vm.error,
      info: vm.info,
      dismiss: vm.dismiss,
    }),
    [vm.showToast, vm.success, vm.error, vm.info, vm.dismiss]
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-container" aria-live="polite" aria-atomic="true">
        {vm.toasts.map((t) => (
          <div key={t.id} className={`toast toast--${t.type}`} role="status">
            <div className="toast-icon" aria-hidden="true">
              {t.type === "success" ? "✓" : t.type === "error" ? "✕" : "ℹ"}
            </div>
            <div className="toast-content">
              {t.title ? <strong className="toast-title">{t.title}</strong> : null}
              <p className="toast-message">{t.message}</p>
            </div>
            <button
              type="button"
              className="toast-dismiss"
              onClick={() => vm.dismiss(t.id)}
              aria-label="Kapat"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
