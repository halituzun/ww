// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts.js";

describe("useKeyboardShortcuts", () => {
  it("g ardindan p tusuna basildiginda projects sayfasina yonlendirir", () => {
    const onNavigate = vi.fn();
    renderHook(() => useKeyboardShortcuts({ onNavigate }));

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "g" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "p" }));

    expect(onNavigate).toHaveBeenCalledWith("projects");
  });

  it("g ardindan s tusuna basildiginda chat sayfasina yonlendirir", () => {
    const onNavigate = vi.fn();
    renderHook(() => useKeyboardShortcuts({ onNavigate }));

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "g" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "s" }));

    expect(onNavigate).toHaveBeenCalledWith("chat");
  });

  it("Escape basildiginda modallari kapatir", () => {
    const onNavigate = vi.fn();
    const onCloseModals = vi.fn();
    renderHook(() => useKeyboardShortcuts({ onNavigate, onCloseModals }));

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onCloseModals).toHaveBeenCalled();
  });
});
