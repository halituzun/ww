// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import App from "./App.js";

const emptyResponse = (): Response => ({
  ok: true,
  status: 200,
  headers: new Headers({ "content-type": "application/json" }),
  json: async () => [],
  text: async () => "[]",
}) as Response;

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => emptyResponse()));
  vi.stubGlobal("WebSocket", class {
    close(): void {}
    send(): void {}
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("App", () => {
  it("genel bakis sayfasini ve yan menuyu cizer", () => {
    render(<App />);
    expect(screen.getAllByText("Genel bakış").length).toBeGreaterThan(0);
    expect(screen.getByText("PROJE")).toBeDefined();
    expect(screen.getByText("SİSTEM")).toBeDefined();
  });

  it("canli baglanti durumunu gosterir", () => {
    render(<App />);
    expect(screen.getByTitle("Canlı olay bağlantısı")).toBeDefined();
  });

  it("projesiz acilista bile ekran cokmeden cizilir", () => {
    expect(() => render(<App />)).not.toThrow();
  });

  it("saglayicilar sayfasina gecis menusu bulunur", () => {
    render(<App />);
    expect(screen.getByRole("button", { name: /API/ })).toBeDefined();
  });
});
