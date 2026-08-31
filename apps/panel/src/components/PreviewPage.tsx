import { PreviewPanel } from "./PreviewPanel.js";
import { ApiConsole } from "./ApiConsole.js";
import { MobilePreviewPanel } from "./MobilePreviewPanel.js";
import type { ApiArtifact } from "../services/projects.js";

export function PreviewPage({
  projectId,
  artifacts,
  onActiveUrl,
  onActiveSession,
}: {
  readonly projectId: string;
  readonly artifacts: readonly ApiArtifact[];
  readonly onActiveUrl?: ((url: string) => void) | undefined;
  readonly onActiveSession?: ((session: string) => void) | undefined;
}) {
  return (
    <div className="preview-page">
      <div className="preview-page__left">
        <div className="card preview-card">
          <PreviewPanel projectId={projectId} onActiveUrl={onActiveUrl} />
        </div>
        <div className="card preview-card">
          <ApiConsole projectId={projectId} artifacts={artifacts} />
        </div>
      </div>
      <div className="preview-page__right">
        <div className="card preview-card">
          <MobilePreviewPanel projectId={projectId} onActiveSession={onActiveSession} />
        </div>
      </div>
    </div>
  );
}
