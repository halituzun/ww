// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import React from "react";
import { PhaseProgressCard } from "./PhaseProgressCard.js";

describe("PhaseProgressCard", () => {
  const dummyProject = {
    project_id: "p1",
    name: "Web Projesi",
    type: "web",
    status: "running" as const,
  };

  it("proje fazlarını listeler ve aktif fazı işaretler", () => {
    render(<PhaseProgressCard project={dummyProject} />);

    expect(screen.getByText("Faz İlerlemesi")).toBeDefined();
    expect(screen.getByText("1. Gereksinim Analizi")).toBeDefined();
    expect(screen.getByText("2. Mimari & Planlama")).toBeDefined();
    expect(screen.getByText("3. Otonom Geliştirme")).toBeDefined();
    expect(screen.getByText("2 / 5 Tamamlandı")).toBeDefined();
  });
});
