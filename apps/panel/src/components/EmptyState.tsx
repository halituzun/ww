import type { ReactNode } from "react";

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  readonly title: string;
  readonly description?: string;
  readonly action?: ReactNode;
  readonly icon?: ReactNode;
}) {
  return (
    <div className="empty-state-box">
      {icon ? <div className="empty-state-icon">{icon}</div> : null}
      <h4 className="empty-state-title">{title}</h4>
      {description ? <p className="empty-state-desc">{description}</p> : null}
      {action ? <div className="empty-state-action">{action}</div> : null}
    </div>
  );
}
