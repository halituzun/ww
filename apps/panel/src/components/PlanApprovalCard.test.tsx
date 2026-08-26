// @vitest-environment jsdom
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, expect, it, vi, afterEach } from "vitest";
import React from "react";
import { PlanApprovalCard } from "./PlanApprovalCard.js";

afterEach(cleanup);

describe("PlanApprovalCard", () => {
  const dummyPlan = {
    plan_id: "plan-101",
    project_id: "prj-1",
    title: "E-Ticaret Mimarisi ve Faz Planı",
    content_md: "### Faz 1: Auth & User\n### Faz 2: Cart",
    status: "proposed" as const,
    plan_version: 1,
  };

  it("onay bekleyen planı doğru çizer ve onay eylemini tetikler", () => {
    const onApprove = vi.fn();
    render(<PlanApprovalCard plan={dummyPlan} onApprove={onApprove} />);

    expect(screen.getByText("E-Ticaret Mimarisi ve Faz Planı")).toBeDefined();
    expect(screen.getByText("Kullanıcı Onayı Bekliyor")).toBeDefined();
    expect(screen.getByText("Sürüm v1")).toBeDefined();

    fireEvent.click(screen.getByText("✓ Planı Onayla ve Başlat"));
    expect(onApprove).toHaveBeenCalled();
  });

  it("revizyon iste butonuna basıldığında gerekçe formunu açar", () => {
    render(<PlanApprovalCard plan={dummyPlan} />);

    fireEvent.click(screen.getByText("↻ Revizyon İste"));
    expect(screen.getByText("Plan Revizyon Gerekçesi")).toBeDefined();
  });
});
