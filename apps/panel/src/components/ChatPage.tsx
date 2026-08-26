import React from "react";
import { messageKindLabel, agentRoleLabel } from "../services/labels.js";
import { PendingQuestions } from "./PendingQuestions.js";
import { ChatComposer } from "./ChatComposer.js";
import { useChatViewModel } from "../viewmodels/useChatViewModel.js";
import { Skeleton } from "./Skeleton.js";
import { Alert } from "./Alert.js";
import { EmptyState } from "./EmptyState.js";

export function ChatPage({
  projectId,
}: {
  readonly projectId: string;
}) {
  const { messages, loading, error, draft, setDraft, send, sending } = useChatViewModel(projectId);

  return (
    <div className="chat-page">
      <div className="chat-page-grid">
        <section className="chat-main-area">
          <div className="chat-header">
            <h2>PM & Agent İletişim Akışı</h2>
            <p className="hint">Tüm konuşmalar ve yürütülen emirler gerçek zamanlı listelenir.</p>
          </div>

          {error ? <Alert type="error" message={error} /> : null}

          <div className="chat-messages-container">
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
                const isUser =
                  m.kind === "user_command" ||
                  (m.kind === "answer" && (!m.from || m.from === "user" || m.from === "human" || m.from === "local-user"));
                const senderName = isUser
                  ? "Siz"
                  : m.from
                  ? agentRoleLabel(m.from)
                  : "PM Agent";

                return (
                  <div
                    key={m.messageId}
                    className={`chat-bubble-row ${isUser ? "chat-bubble-row--user" : "chat-bubble-row--agent"}`}
                  >
                    <div className="chat-bubble-meta">
                      <strong className="chat-sender-name">{senderName}</strong>
                      <span className="pill pill--mini">{messageKindLabel(m.kind)}</span>
                      {m.taskId ? <code>{m.taskId.slice(0, 8)}</code> : null}
                      <span className="chat-time">
                        {new Date(m.createdAt || Date.now()).toLocaleTimeString("tr-TR")}
                      </span>
                    </div>
                    <div className="chat-bubble-text">
                      {m.payload?.text ?? "(metin yok)"}
                    </div>
                  </div>
                );
              })
            )}
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
