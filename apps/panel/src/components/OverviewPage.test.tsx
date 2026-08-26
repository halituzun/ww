// @vitest-environment jsdom
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, expect, it, vi, afterEach } from "vitest";
import { OverviewPage } from "./OverviewPage.js";

afterEach(cleanup);

describe("OverviewPage", () => {
  const dummyProject = {
    project_id: "p-100",
    name: "E-Ticaret Web",
    type: "web",
    status: "running" as const,
    budget_usd: 50,
  };

  it("4 KPI kartini dogru basar", () => {
    const onNavigate = vi.fn();
    render(
      <OverviewPage
        project={dummyProject}
        tasks={[
          { task_id: "t1", title: "Giris Yap", status: "done", priority: 0, updated_at: "" },
          { task_id: "t2", title: "Sepet", status: "working", priority: 0, updated_at: "" },
        ]}
        budget={{
          spentUsd: 12.44,
          limitUsd: 50,
          ratio: 0.25,
          state: "ok",
        }}
        pendingQuestionsCount={2}
        onNavigate={onNavigate}
      />
    );

    expect(screen.getByText("1/2")).toBeDefined();
    expect(screen.getByText("TAMAMLANAN GÖREVLER")).toBeDefined();
    expect(screen.getByText("SENİ BEKLEYEN")).toBeDefined();
    expect(screen.getByText("$12.4400")).toBeDefined();
  });

  it("kpi kartina tiklandiginda ilgili sayfaya yonlendirir", () => {
    const onNavigate = vi.fn();
    render(
      <OverviewPage
        project={dummyProject}
        tasks={[]}
        budget={undefined}
        onNavigate={onNavigate}
      />
    );

    fireEvent.click(screen.getByText("TAMAMLANAN GÖREVLER"));
    expect(onNavigate).toHaveBeenCalledWith("tasks");
  });
});
