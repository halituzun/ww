import { describe, expect, it, vi } from "vitest";
import { fetchPlans, approvePlan, rejectPlan, requestReplan } from "./plans.js";
import * as http from "./http.js";

describe("plans service", () => {
  it("fetchPlans proje planlarını doğru yoldan çeker", async () => {
    const spy = vi.spyOn(http, "getJson").mockResolvedValueOnce([{ plan_id: "p1", title: "Test Plan" }] as never);
    const plans = await fetchPlans("prj-1");
    expect(spy).toHaveBeenCalledWith("/projects/prj-1/plans", {}, "Planlar alınamadı");
    expect(plans).toHaveLength(1);
  });

  it("approvePlan onay isteğini POST eder", async () => {
    const spy = vi.spyOn(http, "requestJson").mockResolvedValueOnce({ ok: true } as never);
    await approvePlan("prj-1", "p1", "uygun");
    expect(spy).toHaveBeenCalledWith(
      "/projects/prj-1/plans/p1/approval",
      expect.objectContaining({ method: "POST", body: { approved: true, note: "uygun" } }),
      "Plan onaylanamadı"
    );
  });

  it("rejectPlan red isteğini POST eder", async () => {
    const spy = vi.spyOn(http, "requestJson").mockResolvedValueOnce({ ok: true } as never);
    await rejectPlan("prj-1", "p1", "kapsam eksik");
    expect(spy).toHaveBeenCalledWith(
      "/projects/prj-1/plans/p1/approval",
      expect.objectContaining({ method: "POST", body: { approved: false, note: "kapsam eksik" } }),
      "Plan reddedilemedi"
    );
  });

  it("requestReplan revizyon isteğini POST eder", async () => {
    const spy = vi.spyOn(http, "requestJson").mockResolvedValueOnce({ ok: true } as never);
    await requestReplan("prj-1", "yeni gereksinim", "ödeme eklenecek");
    expect(spy).toHaveBeenCalledWith(
      "/projects/prj-1/plans/replan",
      expect.objectContaining({ method: "POST", body: { reason: "yeni gereksinim", summary: "ödeme eklenecek" } }),
      "Yeniden planlama talebi gönderilemedi"
    );
  });
});
