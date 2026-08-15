-- Bounded durable inbox scans quarantine only an exact poisoned logical
-- receipt candidate. A newer receipt_version or claim_fence remains eligible.
CREATE TABLE IF NOT EXISTS message_receipt_quarantine (
  quarantine_id UUID,
  project_id UUID,
  receipt_id UUID,
  message_id UUID,
  receipt_version UInt64,
  claim_fence UInt64,
  candidate_id FixedString(64),
  reason_code LowCardinality(String),
  summary String,
  quarantined_at DateTime64(3, 'UTC')
) ENGINE = MergeTree
ORDER BY (project_id, receipt_id, receipt_version, claim_fence, candidate_id, quarantine_id);

-- Recipient-first discovery gives processNext real primary-key pruning. The
-- receipt-first copy then reloads every tie for selected keys, preserving
-- fail-closed identity/version/fence conflict detection.
CREATE TABLE IF NOT EXISTS recipient_message_receipts (
  receipt_id UUID,
  message_id UUID,
  project_id UUID,
  recipient_id UUID,
  recipient_snapshot_json String,
  receipt_version UInt64,
  state LowCardinality(String),
  claim_owner String,
  claim_fence UInt64,
  claim_expires_at Nullable(DateTime64(3, 'UTC')),
  retry_count UInt32,
  next_attempt_at Nullable(DateTime64(3, 'UTC')),
  error String,
  created_at DateTime64(3, 'UTC'),
  scan_bucket UInt8,
  source_hash FixedString(64)
) ENGINE = MergeTree
ORDER BY (
  recipient_id, scan_bucket, created_at, project_id, receipt_id, receipt_version, claim_fence
);

CREATE MATERIALIZED VIEW IF NOT EXISTS recipient_message_receipts_mv
TO recipient_message_receipts AS
SELECT
  receipt_id, message_id, project_id, recipient_id, recipient_snapshot_json,
  receipt_version, state, claim_owner, claim_fence, claim_expires_at,
  retry_count, next_attempt_at, error, created_at,
  toUInt8(cityHash64(receipt_id) % 64) AS scan_bucket,
  hex(SHA256(toJSONString(tuple(
    receipt_id, message_id, project_id, recipient_id, recipient_snapshot_json,
    receipt_version, state, claim_owner, claim_fence, claim_expires_at,
    retry_count, next_attempt_at, error, created_at
  )))) AS source_hash
FROM message_receipts;

INSERT INTO recipient_message_receipts
SELECT
  receipt_id, message_id, project_id, recipient_id, recipient_snapshot_json,
  receipt_version, state, claim_owner, claim_fence, claim_expires_at,
  retry_count, next_attempt_at, error, created_at, scan_bucket, source_hash
FROM
(
  SELECT DISTINCT
    receipt_id, message_id, project_id, recipient_id, recipient_snapshot_json,
    receipt_version, state, claim_owner, claim_fence, claim_expires_at,
    retry_count, next_attempt_at, error, created_at,
    toUInt8(cityHash64(receipt_id) % 64) AS scan_bucket,
    hex(SHA256(toJSONString(tuple(
      receipt_id, message_id, project_id, recipient_id, recipient_snapshot_json,
      receipt_version, state, claim_owner, claim_fence, claim_expires_at,
      retry_count, next_attempt_at, error, created_at
    )))) AS source_hash
  FROM message_receipts
)
WHERE source_hash NOT IN (SELECT source_hash FROM recipient_message_receipts);

CREATE TABLE IF NOT EXISTS receipt_message_receipts (
  receipt_id UUID,
  message_id UUID,
  project_id UUID,
  recipient_id UUID,
  recipient_snapshot_json String,
  receipt_version UInt64,
  state LowCardinality(String),
  claim_owner String,
  claim_fence UInt64,
  claim_expires_at Nullable(DateTime64(3, 'UTC')),
  retry_count UInt32,
  next_attempt_at Nullable(DateTime64(3, 'UTC')),
  error String,
  created_at DateTime64(3, 'UTC'),
  source_hash FixedString(64)
) ENGINE = MergeTree
ORDER BY (project_id, receipt_id, receipt_version, claim_fence, recipient_id);

CREATE MATERIALIZED VIEW IF NOT EXISTS receipt_message_receipts_mv
TO receipt_message_receipts AS
SELECT
  receipt_id, message_id, project_id, recipient_id, recipient_snapshot_json,
  receipt_version, state, claim_owner, claim_fence, claim_expires_at,
  retry_count, next_attempt_at, error, created_at,
  hex(SHA256(toJSONString(tuple(
    receipt_id, message_id, project_id, recipient_id, recipient_snapshot_json,
    receipt_version, state, claim_owner, claim_fence, claim_expires_at,
    retry_count, next_attempt_at, error, created_at
  )))) AS source_hash
FROM message_receipts;

INSERT INTO receipt_message_receipts
SELECT
  receipt_id, message_id, project_id, recipient_id, recipient_snapshot_json,
  receipt_version, state, claim_owner, claim_fence, claim_expires_at,
  retry_count, next_attempt_at, error, created_at, source_hash
FROM
(
  SELECT DISTINCT
    receipt_id, message_id, project_id, recipient_id, recipient_snapshot_json,
    receipt_version, state, claim_owner, claim_fence, claim_expires_at,
    retry_count, next_attempt_at, error, created_at,
    hex(SHA256(toJSONString(tuple(
      receipt_id, message_id, project_id, recipient_id, recipient_snapshot_json,
      receipt_version, state, claim_owner, claim_fence, claim_expires_at,
      retry_count, next_attempt_at, error, created_at
    )))) AS source_hash
  FROM message_receipts
)
WHERE source_hash NOT IN (SELECT source_hash FROM receipt_message_receipts);

-- Global polling cannot use the project-first receipt mirror without scanning
-- every granule. This immutable copy follows the receipt creation order used by
-- the durable keyset cursor below.
CREATE TABLE IF NOT EXISTS global_message_receipts (
  receipt_id UUID,
  message_id UUID,
  project_id UUID,
  recipient_id UUID,
  recipient_snapshot_json String,
  receipt_version UInt64,
  state LowCardinality(String),
  claim_owner String,
  claim_fence UInt64,
  claim_expires_at Nullable(DateTime64(3, 'UTC')),
  retry_count UInt32,
  next_attempt_at Nullable(DateTime64(3, 'UTC')),
  error String,
  created_at DateTime64(3, 'UTC'),
  scan_bucket UInt8,
  source_hash FixedString(64)
) ENGINE = MergeTree
ORDER BY (scan_bucket, created_at, project_id, receipt_id, receipt_version, claim_fence);

CREATE MATERIALIZED VIEW IF NOT EXISTS global_message_receipts_mv
TO global_message_receipts AS
SELECT
  receipt_id, message_id, project_id, recipient_id, recipient_snapshot_json,
  receipt_version, state, claim_owner, claim_fence, claim_expires_at,
  retry_count, next_attempt_at, error, created_at,
  toUInt8(cityHash64(receipt_id) % 64) AS scan_bucket,
  hex(SHA256(toJSONString(tuple(
    receipt_id, message_id, project_id, recipient_id, recipient_snapshot_json,
    receipt_version, state, claim_owner, claim_fence, claim_expires_at,
    retry_count, next_attempt_at, error, created_at
  )))) AS source_hash
FROM message_receipts;

INSERT INTO global_message_receipts
SELECT
  receipt_id, message_id, project_id, recipient_id, recipient_snapshot_json,
  receipt_version, state, claim_owner, claim_fence, claim_expires_at,
  retry_count, next_attempt_at, error, created_at, scan_bucket, source_hash
FROM
(
  SELECT DISTINCT
    receipt_id, message_id, project_id, recipient_id, recipient_snapshot_json,
    receipt_version, state, claim_owner, claim_fence, claim_expires_at,
    retry_count, next_attempt_at, error, created_at,
    toUInt8(cityHash64(receipt_id) % 64) AS scan_bucket,
    hex(SHA256(toJSONString(tuple(
      receipt_id, message_id, project_id, recipient_id, recipient_snapshot_json,
      receipt_version, state, claim_owner, claim_fence, claim_expires_at,
      retry_count, next_attempt_at, error, created_at
    )))) AS source_hash
  FROM message_receipts
)
WHERE source_hash NOT IN (SELECT source_hash FROM global_message_receipts);

-- One cursor exists per recipient plus the nil UUID global scope. Generation is
-- advanced only on wrap; `(generation, key)` is monotonic, so delayed writers
-- from an older generation can never regress or skip the authoritative cursor.
CREATE TABLE IF NOT EXISTS message_receipt_scan_cursors (
  scan_recipient_id UUID,
  generation UInt64,
  cursor_bucket UInt8,
  cursor_created_at DateTime64(3, 'UTC'),
  cursor_project_id UUID,
  cursor_receipt_id UUID
) ENGINE = MergeTree
ORDER BY (
  scan_recipient_id, generation, cursor_bucket, cursor_created_at,
  cursor_project_id, cursor_receipt_id
);

-- Lifecycle-event repair is a global scan with cursor authority physically
-- isolated from delivery recipients. A system-directed receipt legitimately
-- uses SYSTEM_SENTINEL as recipient_id, so UUID sentinel multiplexing in the
-- delivery cursor table would not provide a disjoint namespace.
CREATE TABLE IF NOT EXISTS terminal_receipt_event_scan_cursors (
  scan_recipient_id UUID,
  generation UInt64,
  cursor_bucket UInt8,
  cursor_created_at DateTime64(3, 'UTC'),
  cursor_project_id UUID,
  cursor_receipt_id UUID
) ENGINE = MergeTree
ORDER BY (
  scan_recipient_id, generation, cursor_bucket, cursor_created_at,
  cursor_project_id, cursor_receipt_id
);

-- Invocation-scoped provider evidence avoids the project/time ordered api_usage
-- scan. Full source rows remain available so exact collisions fail closed.
CREATE TABLE IF NOT EXISTS invocation_api_usage (
  usage_id UUID,
  project_id UUID,
  agent_id UUID,
  task_id UUID,
  provider_id LowCardinality(String),
  model String,
  purpose LowCardinality(String),
  prompt_tokens UInt32,
  completion_tokens UInt32,
  cost_usd Float64,
  latency_ms UInt32,
  status LowCardinality(String),
  error_kind String,
  invocation_id UUID,
  task_brief_id UUID,
  assignment_attempt_id UUID,
  prompt_input_snapshot_id UUID,
  fallback_attempt UInt32,
  created_at DateTime64(3, 'UTC'),
  source_hash FixedString(64)
) ENGINE = MergeTree
ORDER BY (
  invocation_id, project_id, agent_id, task_id, task_brief_id,
  assignment_attempt_id, prompt_input_snapshot_id, fallback_attempt,
  purpose, status, usage_id, source_hash
);

CREATE MATERIALIZED VIEW IF NOT EXISTS invocation_api_usage_mv
TO invocation_api_usage AS
SELECT
  usage_id, project_id, agent_id, task_id, provider_id, model, purpose,
  prompt_tokens, completion_tokens, cost_usd, latency_ms, status, error_kind,
  invocation_id, task_brief_id, assignment_attempt_id, prompt_input_snapshot_id,
  fallback_attempt, created_at,
  hex(SHA256(toJSONString(tuple(
    usage_id, project_id, agent_id, task_id, provider_id, model, purpose,
    prompt_tokens, completion_tokens, cost_usd, latency_ms, status, error_kind,
    invocation_id, task_brief_id, assignment_attempt_id, prompt_input_snapshot_id,
    fallback_attempt, created_at
  )))) AS source_hash
FROM api_usage
WHERE invocation_id != toUUID('00000000-0000-0000-0000-000000000000');

INSERT INTO invocation_api_usage
SELECT
  usage_id, project_id, agent_id, task_id, provider_id, model, purpose,
  prompt_tokens, completion_tokens, cost_usd, latency_ms, status, error_kind,
  invocation_id, task_brief_id, assignment_attempt_id, prompt_input_snapshot_id,
  fallback_attempt, created_at, source_hash
FROM
(
  SELECT DISTINCT
    usage_id, project_id, agent_id, task_id, provider_id, model, purpose,
    prompt_tokens, completion_tokens, cost_usd, latency_ms, status, error_kind,
    invocation_id, task_brief_id, assignment_attempt_id, prompt_input_snapshot_id,
    fallback_attempt, created_at,
    hex(SHA256(toJSONString(tuple(
      usage_id, project_id, agent_id, task_id, provider_id, model, purpose,
      prompt_tokens, completion_tokens, cost_usd, latency_ms, status, error_kind,
      invocation_id, task_brief_id, assignment_attempt_id, prompt_input_snapshot_id,
      fallback_attempt, created_at
    )))) AS source_hash
  FROM api_usage
  WHERE invocation_id != toUUID('00000000-0000-0000-0000-000000000000')
)
WHERE source_hash NOT IN (SELECT source_hash FROM invocation_api_usage);

-- Idempotency ownership is a first-class namespace, not a project-wide filter.
CREATE TABLE IF NOT EXISTS idempotency_messages (
  message_id UUID,
  project_id UUID,
  session_id UUID,
  task_id UUID,
  from_agent_id UUID,
  to_agent_id UUID,
  kind LowCardinality(String),
  content String,
  model_ref String,
  created_at DateTime64(3, 'UTC'),
  protocol_version UInt16,
  payload_version UInt16,
  payload_json String,
  payload_hash String,
  envelope_hash String,
  reply_to_message_id UUID,
  correlation_id UUID,
  causation_id UUID,
  idempotency_key String,
  task_brief_id UUID,
  assignment_attempt_id UUID,
  invocation_id UUID,
  prompt_input_snapshot_id UUID,
  deadline_at Nullable(DateTime64(3, 'UTC')),
  priority LowCardinality(String),
  authenticated_principal_json String,
  provenance_json String,
  source_hash FixedString(64)
) ENGINE = MergeTree
ORDER BY (project_id, idempotency_key, message_id, envelope_hash, source_hash);

CREATE MATERIALIZED VIEW IF NOT EXISTS idempotency_messages_mv
TO idempotency_messages AS
SELECT
  message_id, project_id, session_id, task_id, from_agent_id, to_agent_id,
  kind, content, model_ref, created_at, protocol_version, payload_version,
  payload_json, payload_hash, envelope_hash, reply_to_message_id, correlation_id,
  causation_id, idempotency_key, task_brief_id, assignment_attempt_id,
  invocation_id, prompt_input_snapshot_id, deadline_at, priority,
  authenticated_principal_json, provenance_json,
  hex(SHA256(toJSONString(tuple(
    message_id, project_id, session_id, task_id, from_agent_id, to_agent_id,
    kind, content, model_ref, created_at, protocol_version, payload_version,
    payload_json, payload_hash, envelope_hash, reply_to_message_id, correlation_id,
    causation_id, idempotency_key, task_brief_id, assignment_attempt_id,
    invocation_id, prompt_input_snapshot_id, deadline_at, priority,
    authenticated_principal_json, provenance_json
  )))) AS source_hash
FROM messages
WHERE protocol_version = 1 AND idempotency_key != '';

INSERT INTO idempotency_messages
SELECT
  message_id, project_id, session_id, task_id, from_agent_id, to_agent_id,
  kind, content, model_ref, created_at, protocol_version, payload_version,
  payload_json, payload_hash, envelope_hash, reply_to_message_id, correlation_id,
  causation_id, idempotency_key, task_brief_id, assignment_attempt_id,
  invocation_id, prompt_input_snapshot_id, deadline_at, priority,
  authenticated_principal_json, provenance_json, source_hash
FROM
(
  SELECT DISTINCT
    message_id, project_id, session_id, task_id, from_agent_id, to_agent_id,
    kind, content, model_ref, created_at, protocol_version, payload_version,
    payload_json, payload_hash, envelope_hash, reply_to_message_id, correlation_id,
    causation_id, idempotency_key, task_brief_id, assignment_attempt_id,
    invocation_id, prompt_input_snapshot_id, deadline_at, priority,
    authenticated_principal_json, provenance_json,
    hex(SHA256(toJSONString(tuple(
      message_id, project_id, session_id, task_id, from_agent_id, to_agent_id,
      kind, content, model_ref, created_at, protocol_version, payload_version,
      payload_json, payload_hash, envelope_hash, reply_to_message_id, correlation_id,
      causation_id, idempotency_key, task_brief_id, assignment_attempt_id,
      invocation_id, prompt_input_snapshot_id, deadline_at, priority,
      authenticated_principal_json, provenance_json
    )))) AS source_hash
  FROM messages
  WHERE protocol_version = 1 AND idempotency_key != ''
)
WHERE source_hash NOT IN (SELECT source_hash FROM idempotency_messages);

CREATE TABLE IF NOT EXISTS identity_messages AS idempotency_messages
ENGINE = MergeTree
ORDER BY (project_id, message_id, idempotency_key, envelope_hash, source_hash);

CREATE MATERIALIZED VIEW IF NOT EXISTS identity_messages_mv
TO identity_messages AS
SELECT
  message_id, project_id, session_id, task_id, from_agent_id, to_agent_id,
  kind, content, model_ref, created_at, protocol_version, payload_version,
  payload_json, payload_hash, envelope_hash, reply_to_message_id, correlation_id,
  causation_id, idempotency_key, task_brief_id, assignment_attempt_id,
  invocation_id, prompt_input_snapshot_id, deadline_at, priority,
  authenticated_principal_json, provenance_json,
  hex(SHA256(toJSONString(tuple(
    message_id, project_id, session_id, task_id, from_agent_id, to_agent_id,
    kind, content, model_ref, created_at, protocol_version, payload_version,
    payload_json, payload_hash, envelope_hash, reply_to_message_id, correlation_id,
    causation_id, idempotency_key, task_brief_id, assignment_attempt_id,
    invocation_id, prompt_input_snapshot_id, deadline_at, priority,
    authenticated_principal_json, provenance_json
  )))) AS source_hash
FROM messages;

INSERT INTO identity_messages
SELECT
  message_id, project_id, session_id, task_id, from_agent_id, to_agent_id,
  kind, content, model_ref, created_at, protocol_version, payload_version,
  payload_json, payload_hash, envelope_hash, reply_to_message_id, correlation_id,
  causation_id, idempotency_key, task_brief_id, assignment_attempt_id,
  invocation_id, prompt_input_snapshot_id, deadline_at, priority,
  authenticated_principal_json, provenance_json, source_hash
FROM
(
  SELECT DISTINCT
    message_id, project_id, session_id, task_id, from_agent_id, to_agent_id,
    kind, content, model_ref, created_at, protocol_version, payload_version,
    payload_json, payload_hash, envelope_hash, reply_to_message_id, correlation_id,
    causation_id, idempotency_key, task_brief_id, assignment_attempt_id,
    invocation_id, prompt_input_snapshot_id, deadline_at, priority,
    authenticated_principal_json, provenance_json,
    hex(SHA256(toJSONString(tuple(
      message_id, project_id, session_id, task_id, from_agent_id, to_agent_id,
      kind, content, model_ref, created_at, protocol_version, payload_version,
      payload_json, payload_hash, envelope_hash, reply_to_message_id, correlation_id,
      causation_id, idempotency_key, task_brief_id, assignment_attempt_id,
      invocation_id, prompt_input_snapshot_id, deadline_at, priority,
      authenticated_principal_json, provenance_json
    )))) AS source_hash
  FROM messages
)
WHERE source_hash NOT IN (SELECT source_hash FROM identity_messages);
