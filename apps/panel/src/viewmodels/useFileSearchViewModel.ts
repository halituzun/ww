import { useState, useMemo } from "react";
import type { FileIndex } from "../services/projects.js";

export function useFileSearchViewModel(files: readonly FileIndex[], selectedFilePath?: string) {
  const [search, setSearch] = useState("");

  const filteredFiles = useMemo(() => {
    if (!search.trim()) return files;
    const q = search.toLowerCase().trim();
    return files.filter((f) => f.file_path.toLowerCase().includes(q) || (f.summary && f.summary.toLowerCase().includes(q)));
  }, [files, search]);

  const selectedFile = useMemo(
    () => files.find((file) => file.file_path === selectedFilePath),
    [files, selectedFilePath]
  );

  return {
    search,
    setSearch,
    filteredFiles,
    selectedFile,
  };
}
