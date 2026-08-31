export function ChatComposer({
  value,
  onChange,
  onSend,
  disabled,
}: {
  readonly value: string;
  readonly onChange: (val: string) => void;
  readonly onSend: () => void;
  readonly disabled?: boolean | undefined;
}) {
  return (
    <div className="chat-composer">
      <div className="chat-composer-row">
        <input
          type="text"
          className="chat-input"
          aria-label="PM mesajı"
          placeholder="PM'e emir ver veya soru sor…"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && value.trim() && !disabled) {
              onSend();
            }
          }}
          disabled={disabled}
        />
        <button
          type="button"
          className="btn btn--primary"
          onClick={onSend}
          disabled={disabled || !value.trim()}
        >
          Gönder
        </button>
      </div>
    </div>
  );
}
