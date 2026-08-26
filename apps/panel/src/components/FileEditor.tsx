// Dosya görüntüleyici (docs/08 → dosya gezgini + fihrist).
//
// Eskiden yer tutucu metin gösteriyordu: kullanıcı dosyayı gördüğünü sanıyor
// ama içerik hiç okunmuyordu. Artık gerçek içerik yüklenir; okunamazsa bu
// AÇIKÇA söylenir — sahte içerik gösterilmez.
import Editor from '@monaco-editor/react';
import { useFileContentViewModel } from '../viewmodels/useFileContentViewModel.js';

const languageOf = (filePath: string): string => {
  if (/\.tsx?$/.test(filePath)) return 'typescript';
  if (/\.jsx?$/.test(filePath)) return 'javascript';
  if (/\.json$/.test(filePath)) return 'json';
  if (/\.md$/.test(filePath)) return 'markdown';
  return 'plaintext';
};

export function FileEditor({ projectId, filePath, summary }: {
  readonly projectId?: string | undefined;
  readonly filePath?: string | undefined;
  readonly summary?: string | undefined;
}) {
  // docs/09: View'da fetch yasak — içerik yükleme ViewModel'de.
  const { value } = useFileContentViewModel(projectId, filePath);

  return (
    <div className="file-editor">
      {summary !== undefined && <p className="file-editor__summary">{summary}</p>}
      <div className="file-editor__monaco-wrap">
        <Editor
          height="100%"
          language={filePath === undefined ? 'plaintext' : languageOf(filePath)}
          theme="vs-dark"
          value={value}
          options={{ readOnly: true, minimap: { enabled: false }, wordWrap: 'on' }}
        />
      </div>
    </div>
  );
}
