// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import React from "react";
import { TaskDetailDrawer } from "./TaskDetailDrawer.js";

describe("TaskDetailDrawer", () => {
  const dummyTask = {
    task_id: "t-12345678",
    title: "Kullanıcı Oturumu Açma",
    description: "JWT tabanlı oturum yönetimi ekle",
    status: "working",
    priority: 8,
    acceptance_criteria: ["JWT üretilmeli", "Refresh token desteklenmeli"],
    target_files: ["src/auth.ts"],
    tokens_spent: "1450",
    token_budget: 5000,
    attempt: 1,
    max_attempts: 3,
    updated_at: "",
  };

  it("görev detaylarını eksiksiz çizer ve kapatılabilir", () => {
    const onClose = vi.fn();
    render(<TaskDetailDrawer task={dummyTask} onClose={onClose} />);

    expect(screen.getByText("Kullanıcı Oturumu Açma")).toBeDefined();
    expect(screen.getByText("JWT tabanlı oturum yönetimi ekle")).toBeDefined();
    expect(screen.getByText("JWT üretilmeli")).toBeDefined();
    expect(screen.getByText("📄 src/auth.ts")).toBeDefined();
    expect(screen.getByText("çalışıyor")).toBeDefined();

    fireEvent.click(screen.getByLabelText("Kapat"));
    expect(onClose).toHaveBeenCalled();
  });
});
