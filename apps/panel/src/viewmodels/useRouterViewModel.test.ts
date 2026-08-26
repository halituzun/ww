// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, beforeEach } from "vitest";
import { useRouterViewModel } from "./useRouterViewModel.js";

describe("useRouterViewModel", () => {
  beforeEach(() => {
    window.location.hash = "";
  });

  it("varsayilan olarak overview sayfasini acar", () => {
    const { result } = renderHook(() => useRouterViewModel());
    expect(result.current.currentPage).toBe("overview");
  });

  it("hash degisince rotayi gunceller", () => {
    const { result } = renderHook(() => useRouterViewModel());
    act(() => {
      result.current.navigate("tasks");
    });
    expect(result.current.currentPage).toBe("tasks");
    expect(window.location.hash).toBe("#/tasks");
  });
});
