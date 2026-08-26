// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SideNav } from "./SideNav.js";

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
});
