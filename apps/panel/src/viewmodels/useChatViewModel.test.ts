// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { useChatViewModel } from "./useChatViewModel.js";

const mockMessages = [
  {
    messageId: "m1",
    kind: "user_command",
    payload: { text: "Uygulamayı başlat" },
    createdAt: "2026-08-26T10:00:00Z",
  },
  {
    messageId: "m2",
    kind: "question",
    payload: { text: "Hangi veritabanı kullanılacak?" },
    createdAt: "2026-08-26T10:01:00Z",
  },
];

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    text: async () => JSON.stringify(mockMessages),
    json: async () => mockMessages,
  })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useChatViewModel", () => {
  it("mesajlari yukler ve siralar", async () => {
    const { result } = renderHook(() => useChatViewModel("p-1"));
    await act(async () => {
      await result.current.reload();
    });

    expect(result.current.messages.length).toBe(2);
    expect(result.current.messages[0]?.kind).toBe("user_command");
    expect(result.current.messages[1]?.kind).toBe("question");
  });
});
