/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from "vitest";
import React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import { GanttChart } from "./GanttChart.js";
import { useGanttViewModel } from "../viewmodels/useGanttViewModel.js";
import type { Task } from "../services/projects.js";
import type { OrgPlan } from "@ww/shared";

afterEach(() => {
  cleanup();
});

const sampleTasks: Task[] = [
  {
    task_id: "task-1",
    project_id: "prj-1",
    title: "Tetris Tahtası ve Arayüzü",
    status: "done",
    priority: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    version: "1",
  },
  {
    task_id: "task-2",
    project_id: "prj-1",
    title: "Oyun Döngüsü ve Zamanlayıcı",
    status: "working",
    priority: 0,
    depends_on: ["task-1"],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    version: "1",
  },
];

const sampleOrgPlan: OrgPlan = {
  departments: [
    {
      id: "dept-ui",
      name: "Kullanıcı Arayüzü & Sunum",
      group: "design",
      lead_role: "group_lead",
      members: [
        { role: "worker", count: 1, model_tier: "light" },
        { role: "verifier", count: 1, model_tier: "light" },
      ],
      responsibility_patterns: ["src/views/**", "src/styles/**"],
      rationale: "Tasarım",
    },
    {
      id: "dept-core",
      name: "Zamanlayıcı & Çekirdek Motor",
      group: "coding",
      lead_role: "group_lead",
      members: [
        { role: "worker", count: 1, model_tier: "heavy" },
        { role: "verifier", count: 1, model_tier: "medium" },
      ],
      responsibility_patterns: ["src/timer.js"],
      rationale: "Çekirdek",
    },
  ],
  non_department_roles: [],
  concurrency_limit: 2,
  estimated_tokens: 10000,
  estimated_cost_usd: 0.03,
};

describe("GanttChart (Faz F: Zaman Planı)", () => {
  it("departman gruplarını, görev başlıklarını ve Türkçe rol etiketlerini render eder", () => {
    render(<GanttChart tasks={sampleTasks} orgPlan={sampleOrgPlan} />);

    // Departman isimleri
    expect(screen.getAllByText(/Kullanıcı Arayüzü & Sunum/)[0]).toBeDefined();
    expect(screen.getAllByText(/Zamanlayıcı & Çekirdek Motor/)[0]).toBeDefined();

    // Görev başlıkları
    expect(screen.getByText("Tetris Tahtası ve Arayüzü")).toBeDefined();
    expect(screen.getByText("Oyun Döngüsü ve Zamanlayıcı")).toBeDefined();

    // Türkçe rol adları
    expect(screen.getAllByText(/Yapan|Denetleyen/).length).toBeGreaterThan(0);

    // Canlı 'ŞİMDİ' çizgisi
    expect(screen.getByText(/ŞİMDİ/)).toBeDefined();
  });
});
