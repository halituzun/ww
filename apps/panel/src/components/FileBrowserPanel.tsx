// Dosya gezgini sekmesi — SALT GÖRÜNÜM (docs/08 → dosya gezgini + fihrist).
//
// NEDEN AYRI: App.tsx'in 88. satırı 2251 KARAKTERDİ; tüm sekmelerin gövdesi
// tek ternary zincirindeydi. Satır sayısı düşmüştü ama monolit yok olmamış,
// sıkışmıştı — okunamaz bir satır uzun bir dosyadan iyi değildir.
import type { FileIndex } from '../services/projects.js';
import { FileEditor } from './FileEditor.js';
import { FileFihrist } from './FileFihrist.js';

export interface NarratorAnswer {
  readonly answer: string;
  readonly evidenceRefs: readonly string[];
}

export function FileBrowserPanel({
  projectId, files, selectedFile, onSelectFile,
  narratorQuestion, onNarratorQuestion, onAskNarrator, narratorResult,
}: {
  readonly projectId: string;
  readonly files: readonly FileIndex[];
  readonly selectedFile: string | undefined;
  readonly onSelectFile: (filePath: string) => void;
  readonly narratorQuestion: string;
  readonly onNarratorQuestion: (value: string) => void;
  readonly onAskNarrator: () => void;
  readonly narratorResult: NarratorAnswer | undefined;
}) {
  const selected = files.find((file) => file.file_path === selectedFile);

  return (
    <div className="file-browser">
      {/* Boş durum AÇIKÇA söylenir (docs/09 ui_audit): boş liste
          "yükleniyor mu, yok mu?" sorusunu bırakır. */}
      {files.length === 0 ? (
        <p className="hint">Bu projede henüz dosya yok.</p>
      ) : (
        <ul className="file-list">
          {files.map((file) => (
            <li
              key={file.file_path}
              className={selectedFile === file.file_path ? 'active' : ''}
              onClick={() => onSelectFile(file.file_path)}
            >
              <code>{file.file_path}</code>
              <small>{file.layer} · {file.change_count} değişiklik</small>
            </li>
          ))}
        </ul>
      )}

      <FileEditor projectId={projectId} filePath={selectedFile} summary={selected?.summary} />
      <FileFihrist projectId={projectId} file={selected} />

      <div className="narrator-card">
        <h3>Nasıl yapıldı?</h3>
        <div className="command-row">
          <input
            aria-label="Narrator sorusu"
            value={narratorQuestion}
            onChange={(event) => onNarratorQuestion(event.target.value)}
          />
          <button type="button" onClick={onAskNarrator}>Sor</button>
        </div>
        {narratorResult ? (
          <>
            <p>{narratorResult.answer}</p>
            <small>{narratorResult.evidenceRefs.length} kanıt kaynağı</small>
          </>
        ) : null}
      </div>
    </div>
  );
}
