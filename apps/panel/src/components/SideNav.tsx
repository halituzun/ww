import { NAV_ROUTES, type PageId } from "../services/routes.js";

export interface HealthSummary {
  readonly clickhouse: boolean;
  readonly redis: boolean;
}

export function SideNav({
  currentPage,
  onNavigate,
  onOpenCommandPalette,
  counts,
  health,
}: {
  readonly currentPage: PageId;
  readonly onNavigate: (page: PageId) => void;
  readonly onOpenCommandPalette?: (() => void) | undefined;
  readonly counts?: {
    readonly pendingQuestions?: number | undefined;
    readonly runningTasks?: number | undefined;
    readonly auditWarnings?: number | undefined;
  } | undefined;
  readonly health?: HealthSummary | undefined;
}) {
  const projectRoutes = NAV_ROUTES.filter((r) => r.group === "project");
  const systemRoutes = NAV_ROUTES.filter((r) => r.group === "system");

  const isHealthy = health ? health.clickhouse && health.redis : true;

  function renderIcon(icon: string) {
    switch (icon) {
      case "overview":
        return (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="2" y="2" width="5" height="5" rx="1.5" />
            <rect x="9" y="2" width="5" height="5" rx="1.5" />
            <rect x="2" y="9" width="5" height="5" rx="1.5" />
            <rect x="9" y="9" width="5" height="5" rx="1.5" />
          </svg>
        );
      case "canvas":
        return (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="4" cy="4" r="2" />
            <circle cx="12" cy="4" r="2" />
            <circle cx="8" cy="12" r="2" />
            <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" />
          </svg>
        );
      case "tasks":
        return (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
            <path d="M5.5 8l2 2 3.5-4" />
          </svg>
        );
      case "files":
        return (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M3 2.75h5l1.5 2H13v8.5H3z" />
          </svg>
        );
      case "chat":
        return (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M2.5 3.75h11v7h-6l-3 2.5v-2.5h-2z" />
          </svg>
        );
      case "preview":
        return (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="2" y="3" width="12" height="9" rx="1.5" />
            <path d="M6 14h4" />
          </svg>
        );
      case "projects":
        return (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M2 4.5l6-2.5 6 2.5v7l-6 2.5-6-2.5z" />
          </svg>
        );
      case "providers":
        return (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M8 2v3M8 11v3M2 8h3M11 8h3" />
            <circle cx="8" cy="8" r="3" />
          </svg>
        );
      case "budget":
        return (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="8" cy="8" r="5.5" />
            <path d="M8 5v6M6 6.5h3.5a1 1 0 010 2H6.5a1 1 0 000 2H10" />
          </svg>
        );
      case "audit":
        return (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M8 1.75l5.5 2.5v4c0 3-2.4 5.3-5.5 6-3.1-.7-5.5-3-5.5-6v-4z" />
          </svg>
        );
      case "settings":
        return (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="8" cy="8" r="2.5" />
            <path d="M8 1.5v1.5M8 13v1.5M1.5 8h1.5M13 8h1.5M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" />
          </svg>
        );
      default:
        return null;
    }
  }

  return (
    <aside className="sidenav">
      <div className="sidenav__brand">
        <span className="brand-logo">WW</span>
        <div className="brand-info">
          <strong>World Wide</strong>
          <small>Otonom Mühendislik</small>
        </div>
      </div>

      <nav className="sidenav__nav" aria-label="Ana Gezinti">
        <p className="nav-section-title">PROJE</p>
        {projectRoutes.map((route) => {
          const isActive = currentPage === route.id;
          let badge: { count: number; tone: "warning" | "info" } | null = null;
          if (route.id === "chat" && counts?.pendingQuestions && counts.pendingQuestions > 0) {
            badge = { count: counts.pendingQuestions, tone: "warning" };
          } else if (route.id === "tasks" && counts?.runningTasks && counts.runningTasks > 0) {
            badge = { count: counts.runningTasks, tone: "info" };
          }

          return (
            <button
              key={route.id}
              type="button"
              className={`nav-link ${isActive ? "active" : ""}`}
              aria-current={isActive ? "page" : undefined}
              onClick={() => onNavigate(route.id)}
            >
              {renderIcon(route.icon)}
              <span>{route.label}</span>
              {badge ? (
                <span className={`nav-badge nav-badge--${badge.tone}`}>
                  {badge.count}
                </span>
              ) : null}
            </button>
          );
        })}

        <p className="nav-section-title">SİSTEM</p>
        {systemRoutes.map((route) => {
          const isActive = currentPage === route.id;
          let badge: { count: number; tone: "danger" } | null = null;
          if (route.id === "audit" && counts?.auditWarnings && counts.auditWarnings > 0) {
            badge = { count: counts.auditWarnings, tone: "danger" };
          }

          return (
            <button
              key={route.id}
              type="button"
              className={`nav-link ${isActive ? "active" : ""}`}
              aria-current={isActive ? "page" : undefined}
              onClick={() => onNavigate(route.id)}
            >
              {renderIcon(route.icon)}
              <span>{route.label}</span>
              {badge ? (
                <span className={`nav-badge nav-badge--${badge.tone}`}>
                  {badge.count}
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>

      <div className="sidenav__footer">
        <div className="infra-mini-card">
          <div className="infra-mini-card__head">
            <span className="infra-label">ALTYAPI</span>
            <span className={`infra-status ${isHealthy ? "ok" : "warn"}`}>
              {isHealthy ? "Sağlıklı" : "Uyarı"}
            </span>
          </div>
          <div className="infra-mini-card__items">
            <span className="infra-item">
              <i className={`dot ${health?.clickhouse ?? true ? "dot--ok" : "dot--err"}`} />
              ClickHouse
            </span>
            <span className="infra-item">
              <i className={`dot ${health?.redis ?? true ? "dot--ok" : "dot--err"}`} />
              Redis
            </span>
          </div>
        </div>

        {onOpenCommandPalette ? (
          <button
            type="button"
            className="command-palette-trigger"
            onClick={onOpenCommandPalette}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
              <circle cx="7" cy="7" r="4.25" />
              <path d="M10.2 10.2L14 14" />
            </svg>
            <span>Komut Paleti</span>
            <kbd>⌘K</kbd>
          </button>
        ) : null}
      </div>
    </aside>
  );
}
