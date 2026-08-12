-- ww çekirdek şeması — docs/02-clickhouse-semasi.md ile birebir.
-- Son-durum tabloları: ReplacingMergeTree(version); append tabloları: MergeTree + aylık partition.

CREATE TABLE IF NOT EXISTS projects (
  project_id UUID,
  name String,
  slug String,
  type LowCardinality(String),
  status LowCardinality(String),
  description String DEFAULT '',
  workspace_path String DEFAULT '',
  budget_usd_limit Float64 DEFAULT 0,
  settings String DEFAULT '{}',
  active_plan_id UUID DEFAULT toUUID('00000000-0000-0000-0000-000000000000'),
  created_at DateTime64(3, 'UTC'),
  updated_at DateTime64(3, 'UTC'),
  version UInt64
) ENGINE = ReplacingMergeTree(version) ORDER BY project_id;

CREATE TABLE IF NOT EXISTS agents (
  agent_id UUID,
  project_id UUID,
  role LowCardinality(String),
  `group` LowCardinality(String),
  name String,
  model_ref String,
  parent_agent_id UUID DEFAULT toUUID('00000000-0000-0000-0000-000000000000'),
  clone_of UUID DEFAULT toUUID('00000000-0000-0000-0000-000000000000'),
  status LowCardinality(String),
  current_task_id UUID DEFAULT toUUID('00000000-0000-0000-0000-000000000000'),
  prompt_name String DEFAULT '',
  prompt_version UInt32 DEFAULT 0,
  tasks_done UInt32 DEFAULT 0,
  tasks_rejected UInt32 DEFAULT 0,
  created_at DateTime64(3, 'UTC'),
  updated_at DateTime64(3, 'UTC'),
  version UInt64
) ENGINE = ReplacingMergeTree(version) ORDER BY (project_id, agent_id);

CREATE TABLE IF NOT EXISTS plans (
  plan_id UUID,
  project_id UUID,
  plan_version UInt32,
  status LowCardinality(String),
  title String,
  content_md String,
  council_session_id UUID DEFAULT toUUID('00000000-0000-0000-0000-000000000000'),
  team_json String DEFAULT '{}',
  scenarios_json String DEFAULT '{}',
  replan_reason String DEFAULT '',
  supersedes_plan_id UUID DEFAULT toUUID('00000000-0000-0000-0000-000000000000'),
  created_by_agent_id UUID,
  approved_by String DEFAULT '',
  created_at DateTime64(3, 'UTC'),
  version UInt64
) ENGINE = ReplacingMergeTree(version) ORDER BY (project_id, plan_id);

CREATE TABLE IF NOT EXISTS tasks (
  task_id UUID,
  project_id UUID,
  plan_id UUID DEFAULT toUUID('00000000-0000-0000-0000-000000000000'),
  parent_task_id UUID DEFAULT toUUID('00000000-0000-0000-0000-000000000000'),
  title String,
  description String DEFAULT '',
  status LowCardinality(String),
  priority UInt8 DEFAULT 5,
  issuer_agent_id UUID,
  worker_agent_id UUID DEFAULT toUUID('00000000-0000-0000-0000-000000000000'),
  verifier_agent_id UUID DEFAULT toUUID('00000000-0000-0000-0000-000000000000'),
  `group` LowCardinality(String) DEFAULT 'coding',
  depends_on Array(UUID) DEFAULT [],
  target_files Array(String) DEFAULT [],
  attempt UInt8 DEFAULT 0,
  max_attempts UInt8 DEFAULT 3,
  delegation_depth UInt8 DEFAULT 0,
  token_budget UInt32 DEFAULT 0,
  tokens_spent UInt64 DEFAULT 0,
  commit_hash String DEFAULT '',
  result_summary String DEFAULT '',
  reject_reason String DEFAULT '',
  created_at DateTime64(3, 'UTC'),
  updated_at DateTime64(3, 'UTC'),
  version UInt64
) ENGINE = ReplacingMergeTree(version) ORDER BY (project_id, task_id);

CREATE TABLE IF NOT EXISTS messages (
  message_id UUID,
  project_id UUID,
  session_id UUID,
  task_id UUID DEFAULT toUUID('00000000-0000-0000-0000-000000000000'),
  from_agent_id UUID,
  to_agent_id UUID,
  kind LowCardinality(String),
  content String,
  model_ref String DEFAULT '',
  created_at DateTime64(3, 'UTC')
) ENGINE = MergeTree
PARTITION BY toYYYYMM(created_at)
ORDER BY (project_id, session_id, created_at);

CREATE TABLE IF NOT EXISTS events (
  event_id UUID,
  seq UInt64,
  project_id UUID,
  task_id UUID DEFAULT toUUID('00000000-0000-0000-0000-000000000000'),
  agent_id UUID DEFAULT toUUID('00000000-0000-0000-0000-000000000000'),
  event_type LowCardinality(String),
  tool_name LowCardinality(String) DEFAULT '',
  payload String DEFAULT '{}',
  duration_ms UInt32 DEFAULT 0,
  created_at DateTime64(3, 'UTC')
) ENGINE = MergeTree
PARTITION BY toYYYYMM(created_at)
ORDER BY (project_id, created_at, seq);

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id UUID,
  project_id UUID,
  task_id UUID,
  agent_id UUID,
  artifact_type LowCardinality(String),
  name String,
  path String DEFAULT '',
  summary String DEFAULT '',
  commit_hash String DEFAULT '',
  created_at DateTime64(3, 'UTC')
) ENGINE = MergeTree
ORDER BY (project_id, artifact_type, created_at);

CREATE TABLE IF NOT EXISTS file_index (
  project_id UUID,
  file_path String,
  summary String DEFAULT '',
  layer LowCardinality(String) DEFAULT 'other',
  exports Array(String) DEFAULT [],
  related_task_ids Array(UUID) DEFAULT [],
  related_artifact_ids Array(UUID) DEFAULT [],
  related_knowledge_ids Array(UUID) DEFAULT [],
  last_commit_hash String DEFAULT '',
  change_count UInt32 DEFAULT 0,
  updated_at DateTime64(3, 'UTC'),
  version UInt64
) ENGINE = ReplacingMergeTree(version) ORDER BY (project_id, file_path);

CREATE TABLE IF NOT EXISTS knowledge (
  knowledge_id UUID,
  project_id UUID,
  kind LowCardinality(String),
  title String,
  content String,
  tags Array(String) DEFAULT [],
  source_task_id UUID DEFAULT toUUID('00000000-0000-0000-0000-000000000000'),
  source_message_id UUID DEFAULT toUUID('00000000-0000-0000-0000-000000000000'),
  status LowCardinality(String) DEFAULT 'active',
  superseded_by UUID DEFAULT toUUID('00000000-0000-0000-0000-000000000000'),
  created_at DateTime64(3, 'UTC'),
  version UInt64
) ENGINE = ReplacingMergeTree(version) ORDER BY (project_id, knowledge_id);

CREATE TABLE IF NOT EXISTS summaries (
  summary_id UUID,
  project_id UUID,
  scope LowCardinality(String),
  ref_id UUID,
  content String,
  created_by_agent_id UUID,
  created_at DateTime64(3, 'UTC')
) ENGINE = MergeTree
ORDER BY (project_id, scope, created_at);

CREATE TABLE IF NOT EXISTS embeddings (
  embedding_id UUID,
  project_id UUID,
  source_table LowCardinality(String),
  source_id UUID,
  chunk_index UInt16 DEFAULT 0,
  text String,
  vector Array(Float32),
  embedding_model LowCardinality(String),
  created_at DateTime64(3, 'UTC')
) ENGINE = MergeTree
ORDER BY (project_id, source_table, source_id, chunk_index);

CREATE TABLE IF NOT EXISTS prompts (
  prompt_name LowCardinality(String),
  prompt_version UInt32,
  content String,
  variables Array(String) DEFAULT [],
  changelog String DEFAULT '',
  is_active UInt8 DEFAULT 1,
  created_at DateTime64(3, 'UTC'),
  version UInt64
) ENGINE = ReplacingMergeTree(version) ORDER BY (prompt_name, prompt_version);

CREATE TABLE IF NOT EXISTS api_providers (
  provider_id LowCardinality(String),
  display_name String,
  base_url String DEFAULT '',
  enabled UInt8 DEFAULT 1,
  is_default UInt8 DEFAULT 0,
  fallback_order UInt8 DEFAULT 0,
  models Array(String) DEFAULT [],
  key_ref String DEFAULT '',
  health_status LowCardinality(String) DEFAULT 'unknown',
  last_health_check DateTime64(3, 'UTC') DEFAULT toDateTime64(0, 3, 'UTC'),
  updated_at DateTime64(3, 'UTC'),
  version UInt64
) ENGINE = ReplacingMergeTree(version) ORDER BY provider_id;

CREATE TABLE IF NOT EXISTS role_models (
  role LowCardinality(String),
  model_ref String,
  fallback_refs Array(String) DEFAULT [],
  updated_at DateTime64(3, 'UTC'),
  version UInt64
) ENGINE = ReplacingMergeTree(version) ORDER BY role;

CREATE TABLE IF NOT EXISTS api_usage (
  usage_id UUID,
  project_id UUID,
  agent_id UUID DEFAULT toUUID('00000000-0000-0000-0000-000000000000'),
  task_id UUID DEFAULT toUUID('00000000-0000-0000-0000-000000000000'),
  provider_id LowCardinality(String),
  model String,
  purpose LowCardinality(String) DEFAULT 'completion',
  prompt_tokens UInt32 DEFAULT 0,
  completion_tokens UInt32 DEFAULT 0,
  cost_usd Float64 DEFAULT 0,
  latency_ms UInt32 DEFAULT 0,
  status LowCardinality(String) DEFAULT 'ok',
  error_kind String DEFAULT '',
  created_at DateTime64(3, 'UTC')
) ENGINE = MergeTree
PARTITION BY toYYYYMM(created_at)
ORDER BY (project_id, created_at);

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_usage_daily
ENGINE = SummingMergeTree ORDER BY (project_id, provider_id, model, day)
AS SELECT
  project_id,
  provider_id,
  model,
  toDate(created_at) AS day,
  sum(cost_usd) AS cost,
  sum(prompt_tokens + completion_tokens) AS tokens,
  count() AS calls
FROM api_usage
GROUP BY project_id, provider_id, model, day;

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_provider_errors
ENGINE = SummingMergeTree ORDER BY (provider_id, minute)
AS SELECT
  provider_id,
  toStartOfMinute(created_at) AS minute,
  countIf(status != 'ok') AS errors,
  count() AS total
FROM api_usage
GROUP BY provider_id, minute;
