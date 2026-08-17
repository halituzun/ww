// docs/09 → View → ViewModel → Service.
//
// Görüntüleyicinin en önemli davranışı burada korunur: dosya OKUNAMAZSA bu
// açıkça söylenir. Sahte ya da yer tutucu içerik göstermek, kullanıcıya
// dosyayı gördüğü yalanını söyler.
import { useEffect, useState } from 'react';
import { fetchFileContent } from '../services/files.js';

export type FileContentState = 'idle' | 'loading' | 'missing';

export interface FileContentViewModelPorts {
  fetchContent?: typeof fetchFileContent;
}

export interface FileContentViewModel {
  readonly content: string | null;
  readonly state: FileContentState;
  /** Editörde gösterilecek metin; okunamayan dosya için açık uyarı. */
  readonly value: string;
}

export function useFileContentViewModel(
  projectId: string | undefined,
  filePath: string | undefined,
  ports: FileContentViewModelPorts = {},
): FileContentViewModel {
  const load = ports.fetchContent ?? fetchFileContent;
  const [content, setContent] = useState<string | null>(null);
  const [state, setState] = useState<FileContentState>('idle');

  useEffect(() => {
    if (projectId === undefined || filePath === undefined) {
      setContent(null);
      setState('idle');
      return;
    }
    let active = true;
    setState('loading');
    void load(projectId, filePath).then((file) => {
      if (!active) return;
      setContent(file?.content ?? null);
      setState(file === null ? 'missing' : 'idle');
    });
    return () => { active = false; };
  }, [projectId, filePath, load]);

  const value = filePath === undefined
    ? '// Bir dosya seçin'
    : content ?? (state === 'loading' ? '// Yükleniyor…' : `// ${filePath} okunamadı`);

  return { content, state, value };
}
