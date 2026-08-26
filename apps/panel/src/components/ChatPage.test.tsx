// @vitest-environment jsdom
import { render, screen, cleanup } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ChatPage } from "./ChatPage.js";

const mockMessages = [
  {
    messageId: "m1",
    kind: "user_command",
    payload: { text: "Ana sayfayı oluştur" },
    createdAt: "2026-08-26T10:00:00Z",
  },
];

const mockPending = { recipientId: "pm-1", count: 0, messages: [] };

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (String(url).includes("/messages/pending")) {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        text: async () => JSON.stringify(mockPending),
        json: async () => mockPending,
      };
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => JSON.stringify(mockMessages),
      json: async () => mockMessages,
    };
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ChatPage", () => {
  it("mesajlari ve etiketleri turkce basar", async () => {
    render(<ChatPage projectId="p1" />);
    expect(screen.getByText("PM & Agent İletişim Akışı")).toBeDefined();
    expect(await screen.findByText("Ana sayfayı oluştur")).toBeDefined();
    expect(await screen.findByText("kullanıcı emri")).toBeDefined();
  });
});
