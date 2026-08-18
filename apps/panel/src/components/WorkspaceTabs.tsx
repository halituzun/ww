// Sekme dağıtıcısı — SALT GÖRÜNÜM (docs/09 MVVM, docs/08 çalışma alanı).
//
// NEDEN AYRI: App.tsx bu dağıtımı TEK SATIRDA 1083 karakterle, iç içe beş
// ternary olarak yapıyordu. Dosyanın satır sayısı düşmüştü ama monolit yok
// olmamış, sıkışmıştı: okunamaz bir satır uzun bir dosyadan iyi değildir.
// Burada dağıtım açık bir eşlemedir ve her dalın testi vardır.
import { TaskListPanel } from './TaskListPanel.js';
import { TimelinePanel } from './TimelinePanel.js';
import { CanvasPanel } from './CanvasPanel.js';
import { FileBrowserPanel } from './FileBrowserPanel.js';
import { ApiConsole } from './ApiConsole.js';
import { PreviewPanel } from './PreviewPanel.js';
import { MobilePreviewPanel } from './MobilePreviewPanel.js';
import type { ReplayEvent, ReplayState } from '../viewmodels/timeline-replay.js';
import type { ApiArtifact, FileIndex, Task } from '../services/projects.js';

export interface WorkspaceTabsProps {
  readonly tab: string;
  readonly projectId: string;
  readonly tasks: readonly Task[];
  readonly statusCounts: Readonly<Record<string, number>>;
  readonly events: readonly ReplayEvent[];
  readonly timelineCursor: number;
  readonly onTimelineCursor: (next: number) => void;
  readonly replay: ReplayState;
  readonly files: readonly FileIndex[];
  readonly selectedFile: string | undefined;
  readonly onSelectFile: (filePath: string) => void;
  readonly selectedAgent: string | undefined;
  readonly onSelectAgent: (agentId: string | undefined) => void;
  readonly narratorQuestion: string;
  readonly onNarratorQuestion: (next: string) => void;
  readonly onAskNarrator: () => void;
  readonly narratorResult: { answer: string; evidenceRefs: string[] } | undefined;
  readonly apiArtifacts: readonly ApiArtifact[];
  readonly onActiveUrl: (url: string) => void;
  readonly onActiveSession: (session: string) => void;
}

export function WorkspaceTabs(props: WorkspaceTabsProps) {
  switch (props.tab) {
    case 'tasks':
      return <TaskListPanel tasks={props.tasks} statusCounts={props.statusCounts} />;
    case 'timeline':
      return (
        <TimelinePanel
          events={props.events}
          cursor={props.timelineCursor}
          onCursor={props.onTimelineCursor}
          visible={props.replay.visible}
          at={props.replay.at}
        />
      );
    case 'canvas':
      return (
        <CanvasPanel
          projectId={props.projectId}
          events={props.events}
          cursor={props.timelineCursor}
          onCursor={props.onTimelineCursor}
          at={props.replay.at}
          tasks={props.tasks}
          // Canlıdayken O ANKİ durumlar verilmez; tuval güncel durumu çizer.
          // Geçmişi canlı gibi göstermek denetim izini bozar.
          statusByTask={
            props.timelineCursor >= props.events.length ? undefined : props.replay.statusByTask
          }
          selectedAgent={props.selectedAgent}
          onSelectAgent={props.onSelectAgent}
        />
      );
    case 'files':
      return (
        <FileBrowserPanel
          projectId={props.projectId}
          files={props.files}
          selectedFile={props.selectedFile}
          onSelectFile={props.onSelectFile}
          narratorQuestion={props.narratorQuestion}
          onNarratorQuestion={props.onNarratorQuestion}
          onAskNarrator={props.onAskNarrator}
          narratorResult={props.narratorResult}
        />
      );
    case 'api':
      return <ApiConsole projectId={props.projectId} artifacts={props.apiArtifacts} />;
    default:
      // Önizleme varsayılandır (docs/10 test ortamları).
      return (
        <>
          <PreviewPanel projectId={props.projectId} onActiveUrl={props.onActiveUrl} />
          <MobilePreviewPanel projectId={props.projectId} onActiveSession={props.onActiveSession} />
        </>
      );
  }
}
