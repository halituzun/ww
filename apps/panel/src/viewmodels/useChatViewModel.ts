import { useState, useEffect, useCallback, useMemo } from "react";
import { fetchRecentMessages, type ChatMessage } from "../services/questions.js";
import { sendUserCommand } from "../services/projects.js";
import { fetchCanvas, type CanvasNode } from "../services/canvas.js";

export function useChatViewModel(projectId: string) {
  const [rawMessages, setRawMessages] = useState<readonly ChatMessage[]>([]);
  const [nodes, setNodes] = useState<readonly CanvasNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) {
      setRawMessages([]);
      setNodes([]);
      setLoading(false);
      return;
    }
    try {
      const [msgList, canvasData] = await Promise.all([
        fetchRecentMessages(projectId),
        fetchCanvas(projectId).catch(() => ({ nodes: [], edges: [] })),
      ]);
      setRawMessages(msgList);
      setNodes(canvasData.nodes);
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

  // Kronolojik sıralama: En eski üstte, en yeni altta (ASC)
  const messages = useMemo(() => {
    return [...rawMessages].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
  }, [rawMessages]);

  // Agent ID -> Node eşlemesi
  const agentMap = useMemo(() => {
    const map = new Map<string, CanvasNode>();
    const list = Array.isArray(nodes) ? nodes : [];
    for (const node of list) {
      map.set(node.id, node);
    }
    return map;
  }, [nodes]);

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
    agentMap,
    loading,
    error,
    draft,
    setDraft,
    send,
    sending,
    reload: load,
  };
}
