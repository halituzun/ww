-- 0009_project_maps.sql — Faz I: Proje Bilgi Haritası Snapshot'ları

CREATE TABLE IF NOT EXISTS project_maps (
  project_map_id UUID,
  project_id UUID,
  map_json String,
  file_count UInt32,
  function_count UInt32,
  route_count UInt32,
  generated_at DateTime64(3, 'UTC'),
  created_at DateTime64(3, 'UTC'),
  version UInt64,
  row_hash FixedString(64)
) ENGINE = ReplacingMergeTree(version)
PRIMARY KEY (project_id, project_map_id)
ORDER BY (project_id, project_map_id, version);
