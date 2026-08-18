// Fihrist paneli (docs/08 → dosya gezgini + fihrist; docs/11 Faz 5).
//
// NEDEN VAR: Faz 5'in kabul kriteri "bir dosyanın fihristinden ilgili göreve ve
// narrator anlatısına gidilir" diyor. REST bu bağları (`related_task_ids`)
// veriyordu ve ClickHouse'ta doğru dolduruluyordu, ama PANEL onları hiç
// göstermiyordu: kullanıcı bir dosyadan onu üreten işe gidemiyordu.
//
// Narrator sorusu dosyaya göre ÜRETİLİR; kullanıcı soruyu kendisi yazmak
// zorunda kalmaz ve "bu dosya nasıl yapıldı" sorusu tek tıkla cevaplanır.
import { useState } from 'react';
import {
  askNarrator,
  fetchArtifact,
  type ArtifactDetail,
  type FileIndex,
} from '../services/projects.js';

export interface FileFihristViewModel {
  readonly file: FileIndex | undefined;
  readonly relatedTaskIds: readonly string[];
  readonly relatedArtifactIds: readonly string[];
  /** Açılan çıktı kaydı; tıklanmadan yüklenmez. */
  readonly artifact: ArtifactDetail | undefined;
  openArtifact(artifactId: string): Promise<void>;
  readonly narrative: string;
  readonly error: string;
  readonly loading: boolean;
  explain(): Promise<void>;
}

/** Narrator'a sorulacak metin: dosyaya bağlı, kullanıcı yazmaz. */
export function narratorQuestionForFile(filePath: string): string {
  return `${filePath} dosyası nasıl ve neden oluşturuldu?`;
}

export interface FileFihristPorts {
  ask?: typeof askNarrator;
  loadArtifact?: typeof fetchArtifact;
}

export function useFileFihristViewModel(
  projectId: string,
  file: FileIndex | undefined,
  ports: FileFihristPorts = {},
): FileFihristViewModel {
  const ask = ports.ask ?? askNarrator;
  const loadArtifact = ports.loadArtifact ?? fetchArtifact;
  const [artifact, setArtifact] = useState<ArtifactDetail | undefined>();
  const [narrative, setNarrative] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const explain = async (): Promise<void> => {
    if (file === undefined || projectId === '') return;
    setLoading(true);
    setError('');
    try {
      const answer = await ask(projectId, narratorQuestionForFile(file.file_path));
      // Boş cevabı "anlatı geldi" gibi göstermek, kanıtı olmayan bir
      // açıklama varmış izlenimi verir.
      const text = (answer.answer ?? '').trim();
      setNarrative(text);
      if (text === '') setError('Narrator bu dosya için kanıt bulamadı.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Narrator yanıt vermedi');
    } finally {
      setLoading(false);
    }
  };

  const openArtifact = async (artifactId: string): Promise<void> => {
    if (projectId === '') return;
    setError('');
    try {
      setArtifact(await loadArtifact(projectId, artifactId));
    } catch (reason) {
      // Hata yutulursa kullanıcı boş panele bakıp kaydın olmadığını sanır.
      setArtifact(undefined);
      setError(reason instanceof Error ? reason.message : 'Çıktı kaydı alınamadı');
    }
  };

  return {
    file,
    relatedTaskIds: file?.related_task_ids ?? [],
    relatedArtifactIds: file?.related_artifact_ids ?? [],
    artifact,
    openArtifact,
    narrative,
    error,
    loading,
    explain,
  };
}
