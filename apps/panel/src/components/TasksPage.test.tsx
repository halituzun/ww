// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { TasksPage } from "./TasksPage.js";

afterEach(cleanup);

const tasks = [
  { task_id: "t1", title: "Renk yardımcısı", status: "done", priority: 2, updated_at: "" },
  { task_id: "t2", title: "Tahta bileşeni", status: "working", priority: 5, updated_at: "" },
];

describe("TasksPage", () => {
  it("boş projede bos durum mesajı gösterir", () => {
    render(<TasksPage tasks={[]} />);
    expect(screen.getByText(/henüz görev yok/i)).toBeTruthy();
  });

  it("görevler ve filtre sekmeleri render edilir", () => {
    render(<TasksPage tasks={tasks} />);
    // Filtre sekmeleri
    expect(screen.getByText("Tümü")).toBeTruthy();
    expect(screen.getByText("Çalışıyor")).toBeTruthy();
    expect(screen.getByText("Bitti")).toBeTruthy();
    // Görev başlıkları
    expect(screen.getByText("Renk yardımcısı")).toBeTruthy();
    expect(screen.getByText("Tahta bileşeni")).toBeTruthy();
  });

  it("başlıkta toplam görev sayısını gösterir", () => {
    render(<TasksPage tasks={tasks} />);
    expect(screen.getByText("2 Görev")).toBeTruthy();
  });
});
