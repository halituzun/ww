import { describe, expect, it } from "vitest";
import { isTaskDone, isTaskRunning, taskStatusLabel } from "./task-status.js";

describe("taskStatusLabel", () => {
  it("bilinen durumları Türkçeleştirir", () => {
    expect(taskStatusLabel("working")).toBe("çalışıyor");
    expect(taskStatusLabel("done")).toBe("bitti");
  });

  it("bilinmeyen durumu olduğu gibi döner", () => {
    expect(taskStatusLabel("custom_status")).toBe("custom_status");
  });

  it("çalışan ve biten görev durumlarını doğru ayırt eder", () => {
    expect(isTaskRunning("working")).toBe(true);
    expect(isTaskRunning("assigned")).toBe(true);
    expect(isTaskRunning("verifying")).toBe(true);
    expect(isTaskRunning("testing")).toBe(true);
    expect(isTaskRunning("approved")).toBe(true);
    expect(isTaskRunning("queued")).toBe(false);
    expect(isTaskRunning("done")).toBe(false);
    expect(isTaskRunning("running")).toBe(false); // uydurma durum reddedilir

    expect(isTaskDone("done")).toBe(true);
    expect(isTaskDone("working")).toBe(false);
  });
});
