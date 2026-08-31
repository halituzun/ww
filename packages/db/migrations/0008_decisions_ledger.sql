-- 0008_decisions_ledger.sql — Faz H3: Müzakere Karar Defteri Tablosu

CREATE TABLE IF NOT EXISTS decisions (
  decision_id UUID,
  project_id UUID,
  topic String,
  decision Enum8('accepted' = 1, 'rejected' = 2, 'modified' = 3),
  rationale String,
  dissent String,
  turn_number UInt8,
  created_at DateTime64(3, 'UTC'),
  updated_at DateTime64(3, 'UTC'),
  version UInt64,
  row_hash FixedString(64)
) ENGINE = ReplacingMergeTree(version)
PRIMARY KEY (project_id, decision_id)
ORDER BY (project_id, decision_id, version);
