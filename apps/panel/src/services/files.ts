// Dosya içeriği servisi (MVVM: Service katmanı).
//
// NEDEN VAR: görüntüleyici yer tutucu metin gösteriyordu — kullanıcı dosyayı
// gördüğünü sanıyor ama içerik hiç okunmuyordu (docs/08 gerçek içerik ister).
import { getJson } from './http.js';

export interface FileContent {
  readonly path: string;
  readonly size: number;
  readonly content: string;
}

export async function fetchFileContent(
  projectId: string,
  filePath: string,
): Promise<FileContent | null> {
  if (projectId === '' || filePath === '') return null;
  try {
    return await getJson<FileContent>(
      `/projects/${projectId}/files/content?path=${encodeURIComponent(filePath)}`,
      {},
      'Dosya okunamadı',
    );
  } catch {
    // İçerik okunamadıysa yer tutucu UYDURMAYIZ; çağıran boşluğu gösterir.
    return null;
  }
}
