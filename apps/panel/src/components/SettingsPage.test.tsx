// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SettingsPage } from "./SettingsPage.js";

describe("SettingsPage", () => {
  it("altyapi servislerini ve basliklari dogru basar", () => {
    render(<SettingsPage />);
    expect(screen.getByText("Sistem Ayarları & Entegrasyonlar")).toBeDefined();
    expect(screen.getByText("ClickHouse Veritabanı")).toBeDefined();
    expect(screen.getByText("Redis Önbellek")).toBeDefined();
    expect(screen.getByText("WW API Sunucusu")).toBeDefined();
  });
});
