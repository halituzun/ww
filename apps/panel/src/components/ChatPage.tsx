import React, { useEffect, useRef } from "react";
import { messageKindLabel, agentRoleLabel } from "../services/labels.js";
import { PendingQuestions } from "./PendingQuestions.js";
import { ChatComposer } from "./ChatComposer.js";
import { useChatViewModel } from "../viewmodels/useChatViewModel.js";
import { Skeleton } from "./Skeleton.js";
import { Alert } from "./Alert.js";
import { EmptyState } from "./EmptyState.js";

function formatSender(
  fromId: string | undefined,
  kind: string,
  agentMap: Map<string, { label: string; role: string; modelRef?: string }>
): { name: string; shortId?: string; isUser: boolean } {
  // Kullanıcı mesajları: user_command veya kullanıcı cevabı (answer) veya local-user
  const isUser =
    kind === "user_command" ||
    kind === "answer" ||
    fromId === "00000000-0000-0000-0000-000000000001" ||
    fromId === "local-user" ||
    fromId === "user" ||
    fromId === "human" ||
    !fromId;

  if (isUser) {
    return { name: "Sen", isUser: true };
  }

  // Agent mesajları: agentMap'ten rol/etiket çözümle
  const agent = agentMap.get(fromId);
  if (agent) {
    const roleText = agentRoleLabel(agent.role);
    const displayName = agent.label && agent.label !== agent.role ? agent.label : roleText;
    return {
      name: displayName,
      shortId: fromId.length > 8 ? fromId.slice(0, 8) : fromId,
      isUser: false,
    };
  }

  // Eşleşme yoksa agentRoleLabel dene
  const fallbackRole = agentRoleLabel(fromId);
  const name = fallbackRole !== fromId ? fallbackRole : "Agent";
  return {
    name,
    ...(fromId.length > 8 ? { shortId: fromId.slice(0, 8) } : {}),
    isUser: false,
  };
}

export function ChatPage({
  projectId,
}: {
  readonly projectId: string;
}) {
  const { messages, agentMap, loading, error, draft, setDraft, send, sending } = useChatViewModel(projectId);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Yeni mesaj geldiğinde veya ilk yüklemede aşağı kaydır
  useEffect(() => {
    if (typeof messagesEndRef.current?.scrollIntoView === "function") { messagesEndRef.current.scrollIntoView({ behavior: "smooth" }); }
  }, [messages.length]);

  return (
    <div className="chat-page">
      <div className="chat-page-grid">
        <section className="chat-main-area">
          <div className="chat-header">
            <h2>PM & Agent İletişim Akışı</h2>
            <p className="hint">Tüm konuşmalar ve yürütülen emirler gerçek zamanlı listelenir.</p>
          </div>

          {error ? <Alert type="error" message={error} /> : null}

          <div className="chat-messages-container" role="log" aria-live="polite">
            {loading && messages.length === 0 ? (
              <div className="chat-skeletons">
                <Skeleton height="56px" />
                <Skeleton height="56px" />
                <Skeleton height="56px" />
              </div>
            ) : messages.length === 0 ? (
              <EmptyState
                title="Henüz bir mesaj geçmişi yok"
                description="Aşağıdaki alandan PM agent'a ilk talimatınızı verin veya soru sorun."
              />
            ) : (
              messages.map((m) => {
                const sender = formatSender(m.from, m.kind, agentMap);

                return (
                  <div
                    key={m.messageId}
                    className={`chat-bubble-row ${sender.isUser ? "chat-bubble-row--user" : "chat-bubble-row--agent"}`}
                  >
                    <div className="chat-bubble-meta">
                      <strong className="chat-sender-name">{sender.name}</strong>
                      {sender.shortId ? (
                        <code className="chat-sender-id" title={m.from ?? ""}>
                          {sender.shortId}
                        </code>
                      ) : null}
                      <span className={`pill pill--mini ${sender.isUser ? "pill--accent" : ""}`}>
                        {messageKindLabel(m.kind)}
                      </span>
                      {m.taskId ? <code className="chat-task-id">{m.taskId.slice(0, 8)}</code> : null}
                      <span className="chat-time">
                        {new Date(m.createdAt || Date.now()).toLocaleTimeString("tr-TR", {
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                        })}
                      </span>
                    </div>
                    <div className="chat-bubble-text">
                      {m.payload?.text ?? "(metin yok)"}
                    </div>
                  </div>
                );
              })
            )}
            <div ref={messagesEndRef} />
          </div>

          <ChatComposer
            value={draft}
            onChange={setDraft}
            onSend={() => void send()}
            disabled={sending || !projectId}
          />
        </section>

        <aside className="chat-side-rail">
          <PendingQuestions projectId={projectId} />
        </aside>
      </div>
    </div>
  );
}
