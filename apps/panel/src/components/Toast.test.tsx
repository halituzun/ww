// @vitest-environment jsdom
import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import React from "react";
import { ToastProvider, useToast } from "./Toast.js";

function TestComponent() {
  const toast = useToast();
  return (
    <div>
      <button type="button" onClick={() => toast.success("İşlem tamam", "Başarılı")}>
        Tetikle
      </button>
    </div>
  );
}

describe("Toast", () => {
  it("success çağrıldığında ekranda toast gösterir ve kapatılabilir", () => {
    render(
      <ToastProvider>
        <TestComponent />
      </ToastProvider>
    );

    fireEvent.click(screen.getByText("Tetikle"));
    expect(screen.getByText("Başarılı")).toBeDefined();
    expect(screen.getByText("İşlem tamam")).toBeDefined();

    fireEvent.click(screen.getByLabelText("Kapat"));
    expect(screen.queryByText("Başarılı")).toBeNull();
  });
});
