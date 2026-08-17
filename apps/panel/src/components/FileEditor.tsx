// Dosya görüntüleyici (docs/08 → dosya gezgini + fihrist).
//
// Eskiden yer tutucu metin gösteriyordu: kullanıcı dosyayı gördüğünü sanıyor
// ama içerik hiç okunmuyordu. Artık gerçek içerik yüklenir; okunamazsa bu
// AÇIKÇA söylenir — sahte içerik gösterilmez.
import { useEffect, useState } from 'react';
import Editor from '@monaco-editor/react';
import { fetchFileContent } from '../services/files.js';

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
  const [content, setContent] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'missing'>('idle');

  useEffect(() => {
    if (projectId === undefined || filePath === undefined) {
      setContent(null);
      setState('idle');
      return;
    }
    let active = true;
    setState('loading');
    void fetchFileContent(projectId, filePath).then((file) => {
      if (!active) return;
      setContent(file?.content ?? null);
      setState(file === null ? 'missing' : 'idle');
    });
    return () => { active = false; };
  }, [projectId, filePath]);

  const value = filePath === undefined
    ? '// Bir dosya seçin'
    : content ?? (state === 'loading' ? '// Yükleniyor…' : `// ${filePath} okunamadı`);

  return (
    <div className="file-editor">
      {summary !== undefined && <p className="file-editor__summary">{summary}</p>}
      <Editor
        height="360px"
        language={filePath === undefined ? 'plaintext' : languageOf(filePath)}
        theme="vs-dark"
        value={value}
        options={{ readOnly: true, minimap: { enabled: false }, wordWrap: 'on' }}
      />
    </div>
  );
}
