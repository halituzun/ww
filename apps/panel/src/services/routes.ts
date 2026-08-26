export type PageId =
  | "overview"
  | "canvas"
  | "tasks"
  | "files"
  | "chat"
  | "preview"
  | "projects"
  | "providers"
  | "budget"
  | "audit"
  | "settings";

export interface NavRoute {
  readonly id: PageId;
  readonly label: string;
  readonly group: "project" | "system";
  readonly icon: string;
}

export const NAV_ROUTES: readonly NavRoute[] = [
  { id: "overview", label: "Genel bakış", group: "project", icon: "overview" },
  { id: "canvas", label: "Canlı tuval", group: "project", icon: "canvas" },
  { id: "tasks", label: "Görevler & plan", group: "project", icon: "tasks" },
  { id: "files", label: "Dosyalar & fihrist", group: "project", icon: "files" },
  { id: "chat", label: "PM sohbeti", group: "project", icon: "chat" },
  { id: "preview", label: "Test ortamları", group: "project", icon: "preview" },
  { id: "projects", label: "Tüm projeler", group: "system", icon: "projects" },
  { id: "providers", label: "API'ler & modeller", group: "system", icon: "providers" },
  { id: "budget", label: "Kontör panosu", group: "system", icon: "budget" },
  { id: "audit", label: "Denetim", group: "system", icon: "audit" },
  { id: "settings", label: "Ayarlar", group: "system", icon: "settings" },
] as const;

export const DEFAULT_PAGE: PageId = "overview";

export function pageTitle(pageId: PageId): string {
  const found = NAV_ROUTES.find((r) => r.id === pageId);
  return found ? found.label : "Agent çalışma alanı";
}

export function parseHashPage(hash: string): PageId {
  const withoutHash = hash.replace(/^#\/?/, "");
  const [routePart] = withoutHash.split("?");
  const clean = (routePart ?? "").toLowerCase().trim();
  const found = NAV_ROUTES.find((r) => r.id === clean);
  return found ? found.id : DEFAULT_PAGE;
}
