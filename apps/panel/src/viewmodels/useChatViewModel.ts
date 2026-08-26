import { useState, useEffect, useCallback } from "react";
import { fetchRecentMessages, type ChatMessage } from "../services/questions.js";
import { sendUserCommand } from "../services/projects.js";

export function useChatViewModel(projectId: string) {
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) {
      setMessages([]);
      setLoading(false);
      return;
    }
    try {
      const list = await fetchRecentMessages(projectId);
      setMessages(list);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Mesajlar yüklenemedi");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
    const interval = setInterval(() => {
      void load();
    }, 3000);
    return () => clearInterval(interval);
  }, [load]);

  const send = useCallback(async () => {
    if (!projectId || !draft.trim() || sending) return;
    setSending(true);
    try {
      await sendUserCommand(projectId, draft);
      setDraft("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Mesaj gönderilemedi");
    } finally {
      setSending(false);
    }
  }, [projectId, draft, sending, load]);

  return {
    messages,
    loading,
    error,
    draft,
    setDraft,
    send,
    sending,
    reload: load,
  };
}
