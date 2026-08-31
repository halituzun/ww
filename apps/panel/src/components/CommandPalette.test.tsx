// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette.js";

describe("CommandPalette", () => {
  it("kapaliyken DOM basmaz", () => {
    const { container } = render(
      <CommandPalette
        isOpen={false}
        onClose={vi.fn()}
        query=""
        onQueryChange={vi.fn()}
        actions={[]}
        selectedIndex={0}
        onSelectIndex={vi.fn()}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it("acikken eylemleri listeler ve tiklandiginda onSelect cagirilir", () => {
    const onSelect = vi.fn();
    render(
      <CommandPalette
        isOpen={true}
        onClose={vi.fn()}
        query=""
        onQueryChange={vi.fn()}
        actions={[
          { id: "1", category: "Gezinti", title: "Sayfaya Git: Canlı tuval", onSelect },
        ]}
        selectedIndex={0}
        onSelectIndex={vi.fn()}
      />
    );

    const item = screen.getByText("Sayfaya Git: Canlı tuval");
    expect(item).toBeDefined();
    fireEvent.click(item);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
