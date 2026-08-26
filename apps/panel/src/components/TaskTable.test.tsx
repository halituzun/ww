// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import { TaskTable } from "./TaskTable.js";

afterEach(cleanup);

const tasks = [
  { task_id: "t1", title: "Renk yardımcısı", status: "done", priority: 2, updated_at: "" },
  { task_id: "t2", title: "Tahta bileşeni", status: "working", priority: 5, updated_at: "" },
  { task_id: "t3", title: "API entegrasyonu", status: "queued", priority: 0, updated_at: "" },
];

describe("TaskTable", () => {
  it("tablo başlıklarını gösterir", () => {
    render(<TaskTable tasks={tasks} />);
    expect(screen.getByText(/GÖREV/)).toBeTruthy();
    expect(screen.getByText(/DURUM/)).toBeTruthy();
    expect(screen.getByText(/ÖNCELİK/)).toBeTruthy();
  });

  it("görevleri Türkçe durumuyla listeler", () => {
    render(<TaskTable tasks={tasks} />);
    expect(screen.getByText("Renk yardımcısı")).toBeTruthy();
    expect(screen.getByText("Tahta bileşeni")).toBeTruthy();
    // Durum Türkçe (task-status.ts K6)
    expect(screen.getByText("bitti")).toBeTruthy();
    expect(screen.getByText("çalışıyor")).toBeTruthy();
  });

  it("filtreli boş liste uygun mesaj gösterir", () => {
    render(<TaskTable tasks={[]} />);
    expect(screen.getByText(/filtreye uygun/i)).toBeTruthy();
  });

  it("satır butonuna tıklayınca onSelectTask çağrılır", () => {
    const onSelect = vi.fn();
    render(<TaskTable tasks={tasks} onSelectTask={onSelect} />);
    // İlk satır butonu: aria-label ile bulunur
    const btn = screen.getByRole("button", { name: /Renk yardımcısı görev detayını aç/ });
    fireEvent.click(btn);
    expect(onSelect).toHaveBeenCalledWith("t1");
  });

  it("satır butonları klavye ile erişilebilir (tabIndex miras)", () => {
    render(<TaskTable tasks={tasks} onSelectTask={() => {}} />);
    const buttons = screen.getAllByRole("button");
    // Her görev için bir button var
    expect(buttons.length).toBeGreaterThanOrEqual(3);
  });

  it("öncelik sütunu görüntülenir", () => {
    render(<TaskTable tasks={tasks} />);
    // priority=2 olan görev
    expect(screen.getByText("2")).toBeTruthy();
    // priority=5 olan görev
    expect(screen.getByText("5")).toBeTruthy();
  });
});
