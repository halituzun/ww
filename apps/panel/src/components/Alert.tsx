import type { ReactNode } from "react";

export function Alert({
  type = "error",
  title,
  message,
  children,
}: {
  readonly type?: "error" | "warning" | "info" | "success";
  readonly title?: string;
  readonly message?: string;
  readonly children?: ReactNode;
}) {
  return (
    <div className={`alert-box alert-box--${type}`} role={type === "error" ? "alert" : "status"}>
      {title ? <strong className="alert-title">{title}</strong> : null}
      {message ? <p className="alert-message">{message}</p> : null}
      {children}
    </div>
  );
}
