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
    const trimmed = tokenInput.trim();
    if (!trimmed) {
      setTokenValidationResult("Lütfen bir token girin.");
      return;
    }
    setValidating(true);
    setTokenValidationResult(null);
    try {
      const token = trimmed.startsWith("Bearer ") ? trimmed.slice(7).trim() : trimmed;
      const res = await fetch("http://localhost:4000/projects", {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        setTokenValidationResult("Token doğrulandı: Oturum geçerli.");
      } else if (res.status === 401) {
        setTokenValidationResult("Geçersiz token: Yetkilendirme reddedildi (401).");
      } else {
        setTokenValidationResult(`Sunucu yanıtı: ${res.status}`);
      }
    } catch {
      setTokenValidationResult("Sunucuya ulaşılamadı veya ağ hatası.");
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
