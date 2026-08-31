import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  createProjectMapSnapshot,
  fetchProjectMap,
  type ProjectMap,
  type ProjectMapFile,
} from '../services/projects.js';

export interface ProjectMapStats {
  readonly fileCount: number;
  readonly functionCount: number;
  readonly routeCount: number;
  readonly exportedFunctionCount: number;
}

export interface ProjectMapViewModelPorts {
  readonly load?: typeof fetchProjectMap;
  readonly saveSnapshot?: typeof createProjectMapSnapshot;
}

const EMPTY_STATS: ProjectMapStats = Object.freeze({
  fileCount: 0,
  functionCount: 0,
  routeCount: 0,
  exportedFunctionCount: 0,
});

function fileMatches(file: ProjectMapFile, query: string): boolean {
  if (query === '') return true;
  const haystack = [
    file.filePath,
    file.layer,
    ...file.exports,
    ...file.functions.map((fn) => `${fn.parent}.${fn.name}`),
    ...file.routes.map((route) => `${route.httpMethod} ${route.routePath} ${route.controller}.${route.methodName}`),
  ].join(' ').toLocaleLowerCase('tr-TR');
  return haystack.includes(query);
}

export function useProjectMapViewModel(
  projectId: string,
  ports: ProjectMapViewModelPorts = {},
) {
  const load = ports.load ?? fetchProjectMap;
  const saveSnapshot = ports.saveSnapshot ?? createProjectMapSnapshot;
  const [map, setMap] = useState<ProjectMap | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [snapshotMessage, setSnapshotMessage] = useState('');

  const refresh = useCallback(async () => {
    if (projectId === '') return;
    setLoading(true);
    try {
      const next = await load(projectId);
      setMap(next);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Proje haritası alınamadı');
    } finally {
      setLoading(false);
    }
  }, [load, projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const persistSnapshot = useCallback(async () => {
    if (projectId === '') return;
    setSaving(true);
    setSnapshotMessage('');
    try {
      const result = await saveSnapshot(projectId);
      setMap(result.snapshot.map_json);
      setSnapshotMessage(`Snapshot #${result.snapshot.project_map_id.slice(0, 8)} kaydedildi`);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Proje haritası snapshot kaydedilemedi');
    } finally {
      setSaving(false);
    }
  }, [projectId, saveSnapshot]);

  const normalizedQuery = query.trim().toLocaleLowerCase('tr-TR');
  const files = useMemo(
    () => Object.freeze((map?.files ?? []).filter((file) => fileMatches(file, normalizedQuery))),
    [map, normalizedQuery],
  );
  const stats = useMemo((): ProjectMapStats => {
    if (map === null) return EMPTY_STATS;
    return Object.freeze({
      fileCount: map.fileCount,
      functionCount: map.functionCount,
      routeCount: map.routeCount,
      exportedFunctionCount: map.functions.filter((fn) => fn.exported).length,
    });
  }, [map]);

  return {
    map,
    files,
    stats,
    query,
    setQuery,
    error,
    loading,
    saving,
    snapshotMessage,
    refresh,
    persistSnapshot,
  };
}
