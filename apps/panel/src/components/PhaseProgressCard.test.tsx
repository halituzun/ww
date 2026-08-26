// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import React from "react";
import { PhaseProgressCard, type PhaseItem } from "./PhaseProgressCard.js";

describe("PhaseProgressCard", () => {
  it("veri (phases) yoksa hiçbir şey çizmez", () => {
    const { container } = render(<PhaseProgressCard />);
    expect(container.firstChild).toBeNull();
  });

  it("boş dizi gelirse hiçbir şey çizmez", () => {
    const { container } = render(<PhaseProgressCard phases={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("gerçek faz listesi gelince kartı çizer", () => {
    const phases: PhaseItem[] = [
      { id: "f1", name: "Gereksinim", status: "done" },
      { id: "f2", name: "Geliştirme", status: "active" },
      { id: "f3", name: "Dağıtım", status: "waiting" },
    ];
    render(<PhaseProgressCard phases={phases} />);

    expect(screen.getByText("Faz İlerlemesi")).toBeDefined();
    expect(screen.getByText("Gereksinim")).toBeDefined();
    expect(screen.getByText("Geliştirme")).toBeDefined();
    expect(screen.getByText("1 / 3 Tamamlandı")).toBeDefined();
  });
});
