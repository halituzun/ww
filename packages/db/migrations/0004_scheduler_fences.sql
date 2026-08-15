-- Faz 4 scheduler zaman-kesiti ve agent assignment fencing alanlari.
-- Epoch observed_at eski planlar icin created_at mantiksal backfill sentinelidir.
-- Her ifade migration kaydi yazilmadan onceki bir restartta guvenle tekrarlanabilir.

ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS observed_at DateTime64(3, 'UTC')
  DEFAULT toDateTime64(0, 3, 'UTC');

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS assignment_fence UInt64 DEFAULT 0;

ALTER TABLE effect_ledger
  ADD COLUMN IF NOT EXISTS lease_fence UInt64 DEFAULT 0;

-- ReplacingMergeTree exact retry satirlarini birlestirebilir. Kabul gozlemleri
-- ayri append-only tabloda kalir; repository version + stable row_hash icin min'i katlar.
CREATE TABLE IF NOT EXISTS plan_acceptance_observations (
  project_id UUID,
  plan_id UUID,
  version UInt64,
  row_hash String,
  observed_at DateTime64(3, 'UTC')
) ENGINE = MergeTree
ORDER BY (project_id, plan_id, version, row_hash, observed_at);

CREATE MATERIALIZED VIEW IF NOT EXISTS plan_acceptance_observations_mv
TO plan_acceptance_observations AS
SELECT
  project_id,
  plan_id,
  version,
  row_hash,
  if(
    observed_at = toDateTime64(0, 3, 'UTC'),
    created_at,
    observed_at
  ) AS observed_at
FROM plans;

-- CREATE MATERIALIZED VIEW gecmis bloklari doldurmaz. Bu backfill tekrar calisirsa
-- yalniz ayni gozlemi yineler; min(observed_at) sonucu degismez.
INSERT INTO plan_acceptance_observations
  (project_id, plan_id, version, row_hash, observed_at)
SELECT
  project_id,
  plan_id,
  version,
  row_hash,
  if(
    observed_at = toDateTime64(0, 3, 'UTC'),
    created_at,
    observed_at
  )
FROM plans;

-- effect_ledger causation kimligine gore siralidir; task-scope scheduler
-- sorgulari icin ayri projection fiziksel granule pruning saglar.
CREATE TABLE IF NOT EXISTS task_effect_ledger (
  task_id UUID,
  causation_id UUID,
  stable_effect_id String,
  project_id UUID,
  assignment_attempt_id UUID,
  effect_type LowCardinality(String),
  request_hash String,
  replay_safety LowCardinality(String),
  state LowCardinality(String),
  result_json String,
  error String,
  effect_version UInt64,
  lease_fence UInt64,
  created_at DateTime64(3, 'UTC')
) ENGINE = MergeTree
ORDER BY (task_id, causation_id, stable_effect_id, effect_version, lease_fence);

CREATE MATERIALIZED VIEW IF NOT EXISTS task_effect_ledger_mv
TO task_effect_ledger AS
SELECT
  task_id,
  causation_id,
  stable_effect_id,
  project_id,
  assignment_attempt_id,
  effect_type,
  request_hash,
  replay_safety,
  state,
  result_json,
  error,
  effect_version,
  lease_fence,
  created_at
FROM effect_ledger
WHERE task_id != toUUID('00000000-0000-0000-0000-000000000000');

-- Yeni MV gecmis bloklari doldurmaz. Exact kopyalar effect fold tarafindan
-- katlanir; bu nedenle yarim backfill sonrasi tekrar calistirmak guvenlidir.
INSERT INTO task_effect_ledger
SELECT
  task_id,
  causation_id,
  stable_effect_id,
  project_id,
  assignment_attempt_id,
  effect_type,
  request_hash,
  replay_safety,
  state,
  result_json,
  error,
  effect_version,
  lease_fence,
  created_at
FROM effect_ledger
WHERE task_id != toUUID('00000000-0000-0000-0000-000000000000');

-- Redis task lease counteri kayboldugunda tek task-indexed kaynaktan durable
-- taban bulunur. Append-only gozlemler exact retry/backfill kopyalarina dayanir.
CREATE TABLE IF NOT EXISTS task_lease_fence_observations (
  task_id UUID,
  source LowCardinality(String),
  source_identity String,
  lease_fence UInt64
) ENGINE = MergeTree
ORDER BY (task_id, source, lease_fence, source_identity);

CREATE MATERIALIZED VIEW IF NOT EXISTS assignment_attempt_task_fences_mv
TO task_lease_fence_observations AS
SELECT
  task_id,
  'assignment_attempt' AS source,
  toString(assignment_attempt_id) AS source_identity,
  lease_fence
FROM assignment_attempts;

CREATE MATERIALIZED VIEW IF NOT EXISTS task_causal_entry_task_fences_mv
TO task_lease_fence_observations AS
SELECT
  task_id,
  'task_causal_entry' AS source,
  toString(entry_id) AS source_identity,
  lease_fence
FROM task_causal_entries;

CREATE MATERIALIZED VIEW IF NOT EXISTS effect_task_fences_mv
TO task_lease_fence_observations AS
SELECT
  task_id,
  'effect' AS source,
  concat(toString(causation_id), ':', stable_effect_id, ':', toString(effect_version))
    AS source_identity,
  lease_fence
FROM effect_ledger
WHERE task_id != toUUID('00000000-0000-0000-0000-000000000000');

INSERT INTO task_lease_fence_observations
SELECT task_id, 'assignment_attempt', toString(assignment_attempt_id), lease_fence
FROM assignment_attempts;

INSERT INTO task_lease_fence_observations
SELECT task_id, 'task_causal_entry', toString(entry_id), lease_fence
FROM task_causal_entries;

INSERT INTO task_lease_fence_observations
SELECT
  task_id,
  'effect',
  concat(toString(causation_id), ':', stable_effect_id, ':', toString(effect_version)),
  lease_fence
FROM effect_ledger
WHERE task_id != toUUID('00000000-0000-0000-0000-000000000000');
