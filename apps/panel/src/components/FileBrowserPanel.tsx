import type { FileIndex } from "../services/projects.js";
import { FileEditor } from "./FileEditor.js";
import { FileFihrist } from "./FileFihrist.js";
import { useFileSearchViewModel } from "../viewmodels/useFileSearchViewModel.js";

export interface NarratorAnswer {
  readonly answer: string;
  readonly evidenceRefs: readonly string[];
}

export function FileBrowserPanel({
  projectId,
  files,
  selectedFile,
  onSelectFile,
  narratorQuestion,
  onNarratorQuestion,
  onAskNarrator,
  narratorResult,
  onSelectTask,
}: {
  readonly projectId: string;
  readonly files: readonly FileIndex[];
  readonly selectedFile: string | undefined;
  readonly onSelectFile: (filePath: string) => void;
  readonly narratorQuestion: string;
  readonly onNarratorQuestion: (value: string) => void;
  readonly onAskNarrator: () => void;
  readonly narratorResult: NarratorAnswer | undefined;
  readonly onSelectTask?: ((taskId: string) => void) | undefined;
}) {
  const { search, setSearch, filteredFiles, selectedFile: selected } =
    useFileSearchViewModel(files, selectedFile);

  if (files.length === 0) {
    return <p className="hint">Bu projede henüz dosya yok.</p>;
  }

  return (
    <div className="file-browser file-browser--3col">
      <aside className="file-browser__tree-col">
        <div className="file-tree-header">
          <input
            type="text"
            className="file-search-input"
            aria-label="Dosya ara"
            placeholder="Dosya ara…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <ul className="file-list">
          {filteredFiles.map((file) => {
            const isSelected = selectedFile === file.file_path;
            return (
              <li
                key={file.file_path}
                className={`file-list-item ${isSelected ? "active" : ""}`}
                onClick={() => onSelectFile(file.file_path)}
              >
                <div className="file-item-main">
                  <code>{file.file_path}</code>
                  <small>{file.layer} · {file.change_count} değişiklik</small>
                </div>
              </li>
            );
          })}
        </ul>
      </aside>

      <section className="file-browser__editor-col">
        <FileEditor projectId={projectId} filePath={selectedFile} summary={selected?.summary} />
      </section>

      <aside className="file-browser__fihrist-col">
        <FileFihrist projectId={projectId} file={selected} onSelectTask={onSelectTask} />

        <div className="narrator-card">
          <h3>Nasıl yapıldı?</h3>
          <p className="hint">Dosyanın hangi kararla ve görevle üretildiğini Narrator'a sorun:</p>
          <div className="command-row">
            <input
              aria-label="Narrator sorusu"
              placeholder="Örn: Bu dosya hangi kararla oluşturuldu?"
              value={narratorQuestion}
              onChange={(event) => onNarratorQuestion(event.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && narratorQuestion.trim()) onAskNarrator();
              }}
            />
            <button type="button" className="btn btn--primary" onClick={onAskNarrator}>
              Sor
            </button>
          </div>
          {narratorResult ? (
            <div className="narrator-result-box">
              <p>{narratorResult.answer}</p>
              <small>{narratorResult.evidenceRefs.length} kanıt kaynağı</small>
            </div>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
