// @vitest-environment jsdom
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SideNav } from "./SideNav.js";

afterEach(cleanup);

describe("SideNav", () => {
  it("tum rotalari listeler ve aktif rotada aria-current page bulunur", () => {
    const onNavigate = vi.fn();
    render(
      <SideNav
        currentPage="overview"
        onNavigate={onNavigate}
        counts={{ pendingQuestions: 3, runningTasks: 2 }}
      />
    );

    const overviewBtn = screen.getByText("Genel bakış").closest("button");
    expect(overviewBtn?.getAttribute("aria-current")).toBe("page");

    const tasksBtn = screen.getByText(/Görevler/).closest("button");
    expect(tasksBtn?.getAttribute("aria-current")).toBeNull();

    fireEvent.click(screen.getByText(/Görevler/));
    expect(onNavigate).toHaveBeenCalledWith("tasks");
  });

  it("bilinmeyen saglik durumunda 3/3 ayakta demez, durum aliniyor gosterir", () => {
    render(
      <SideNav
        currentPage="overview"
        onNavigate={() => {}}
        health={undefined}
      />
    );
    expect(screen.getByText("Durum alınıyor…")).toBeDefined();
  });

  it("tam saglik durumunda 3/3 ayakta gosterir", () => {
    render(
      <SideNav
        currentPage="overview"
        onNavigate={() => {}}
        health={{ clickhouse: true, redis: true, api: true }}
      />
    );
    expect(screen.getByText("3/3 ayakta")).toBeDefined();
  });

  it("kismi saglik durumunda uyarili sayac gosterir", () => {
    render(
      <SideNav
        currentPage="overview"
        onNavigate={() => {}}
        health={{ clickhouse: true, redis: false, api: true }}
      />
    );
    expect(screen.getByText("2/3 ayakta")).toBeDefined();
  });
});
