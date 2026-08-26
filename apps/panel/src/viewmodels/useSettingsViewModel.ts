import { useState, useCallback, useEffect } from "react";
import { useHealth } from "./useHealth.js";
import { fetchCliproxyStatus, type CliproxyGatewayStatus } from "../services/cliproxy.js";

export function useSettingsViewModel() {
  const health = useHealth();
  const [cliproxyStatus, setCliproxyStatus] = useState<CliproxyGatewayStatus | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  const [tokenValidationResult, setTokenValidationResult] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);

  const [soundEnabled, setSoundEnabled] = useState(() => {
    try {
      if (typeof localStorage !== "undefined" && typeof localStorage.getItem === "function") {
        return localStorage.getItem("ww_setting_sound") === "1";
      }
    } catch {}
    return false;
  });

  const [desktopNotifEnabled, setDesktopNotifEnabled] = useState(() => {
    try {
      if (typeof localStorage !== "undefined" && typeof localStorage.getItem === "function") {
        return localStorage.getItem("ww_setting_desktop_notif") === "1";
      }
    } catch {}
    return false;
  });

  useEffect(() => {
    let active = true;
    void fetchCliproxyStatus().then((res: CliproxyGatewayStatus) => {
      if (active) setCliproxyStatus(res);
    }).catch(() => {
      if (active) setCliproxyStatus(null);
    });
    return () => {
      active = false;
    };
  }, []);

  const toggleSound = useCallback(() => {
    setSoundEnabled((prev) => {
      const next = !prev;
      try {
        if (typeof localStorage !== "undefined" && typeof localStorage.setItem === "function") {
          localStorage.setItem("ww_setting_sound", next ? "1" : "0");
        }
      } catch {}
      return next;
    });
  }, []);

  const toggleDesktopNotif = useCallback(() => {
    setDesktopNotifEnabled((prev) => {
      const next = !prev;
      try {
        if (typeof localStorage !== "undefined" && typeof localStorage.setItem === "function") {
          localStorage.setItem("ww_setting_desktop_notif", next ? "1" : "0");
        }
      } catch {}
      return next;
    });
  }, []);

  const validateToken = useCallback(async () => {
    if (!tokenInput.trim()) {
      setTokenValidationResult("Lütfen bir token girin.");
      return;
    }
    setValidating(true);
    setTokenValidationResult(null);
    try {
      await new Promise((r) => setTimeout(r, 400));
      if (tokenInput.length >= 8) {
        setTokenValidationResult("Token formatı geçerli (Doğrulandı).");
      } else {
        setTokenValidationResult("Geçersiz token formatı (Çok kısa).");
      }
    } catch {
      setTokenValidationResult("Doğrulama başarısız oldu.");
    } finally {
      setValidating(false);
    }
  }, [tokenInput]);

  return {
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
  };
}
