// Tek kaynak: docs/02-clickhouse-semasi.md ve docs/03-agent-sistemi.md ile birebir.
export const TASK_STATUSES = [
  'queued', 'assigned', 'working', 'verifying', 'testing', 'approved',
  'rejected', 'done', 'failed', 'cancelled', 'escalated', 'waiting_user',
] as const;

export const AGENT_STATUSES = ['idle', 'busy', 'waiting_verify', 'waiting_answer', 'stopped'] as const;

export const AGENT_ROLES = [
  'pm', 'council_member', 'group_lead', 'interviewer', 'worker', 'verifier',
  'standards_auditor', 'researcher', 'professor', 'creator', 'summarizer', 'narrator',
] as const;

export const AGENT_GROUPS = [
  'management', 'analysis', 'design', 'db', 'coding', 'research', 'reasoning',
  'ui_audit', 'mvvm_audit', 'db_write_audit',
] as const;

export const MESSAGE_KINDS = [
  'question', 'answer', 'order', 'proposal', 'objection', 'synthesis',
  'report', 'escalation', 'user_command', 'verdict',
] as const;

export const MESSAGE_RECEIPT_STATES = [
  'enqueued', 'claimed', 'retry_scheduled', 'processed', 'failed',
] as const;

export const MESSAGE_PRIORITIES = ['normal', 'urgent'] as const;

export const PROMPT_MESSAGE_ROLES = ['system', 'user', 'assistant', 'tool'] as const;

export const PAYLOAD_PROVENANCE_CLASSES = [
  'user_input', 'agent_message', 'model_output', 'tool_result', 'memory', 'diff',
  'system_generated',
] as const;

export const COMMUNICATION_EVENT_TYPES = [
  'message_stored', 'message_rejected', 'receipt_changed', 'brief_sealed',
  'brief_rebased', 'policy_decision', 'task_handoff',
] as const;

export const EVENT_TYPES = [
  'tool_call', 'tool_result', 'api_call', 'decision', 'status_change', 'error',
  'commit', 'lock_acquired', 'lock_released', 'escalation', 'clone_spawned',
  'test_run', 'process_started', 'process_stopped', 'recovery_completed',
  ...COMMUNICATION_EVENT_TYPES,
] as const;

// Stable IDs are persisted with every deterministic guard decision.
export const POLICY_RULE_IDS = [
  'COMM-001', 'COMM-002', 'COMM-003', 'COMM-004', 'COMM-005', 'COMM-006',
  'TASK-001', 'TASK-002', 'TASK-003', 'TASK-004',
  'TOOL-001', 'TOOL-002', 'TOOL-003', 'TOOL-004',
] as const;

export const PROJECT_TYPES = ['web', 'mobile', 'api', 'fullstack'] as const;

export const PROJECT_STATUSES = [
  'draft', 'gathering', 'planning', 'running', 'paused', 'completed', 'archived',
] as const;

export const PLAN_STATUSES = ['debating', 'proposed', 'approved', 'superseded', 'rejected'] as const;

export const ARTIFACT_TYPES = [
  'controller', 'service', 'repository', 'model', 'view', 'viewmodel', 'component',
  'schema', 'api_endpoint', 'design_decision', 'test', 'config', 'doc',
] as const;

export const KNOWLEDGE_KINDS = ['requirement', 'decision', 'constraint', 'concept', 'standard', 'glossary'] as const;

export const SUMMARY_SCOPES = ['task', 'phase', 'day', 'council', 'agent_session'] as const;

// messages.from/to için sabit kimlikler
export const USER_SENTINEL = '00000000-0000-0000-0000-000000000001';
export const BROADCAST_SENTINEL = '00000000-0000-0000-0000-000000000002';
export const SYSTEM_SENTINEL = '00000000-0000-0000-0000-000000000003';
export const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type AgentStatus = (typeof AGENT_STATUSES)[number];
export type AgentRole = (typeof AGENT_ROLES)[number];
export type AgentGroup = (typeof AGENT_GROUPS)[number];
export type MessageKind = (typeof MESSAGE_KINDS)[number];
export type MessageReceiptState = (typeof MESSAGE_RECEIPT_STATES)[number];
export type MessagePriority = (typeof MESSAGE_PRIORITIES)[number];
export type PromptMessageRole = (typeof PROMPT_MESSAGE_ROLES)[number];
export type PayloadProvenanceClass = (typeof PAYLOAD_PROVENANCE_CLASSES)[number];
export type EventType = (typeof EVENT_TYPES)[number];
export type PolicyRuleId = (typeof POLICY_RULE_IDS)[number];
export type ProjectType = (typeof PROJECT_TYPES)[number];
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export type PlanStatus = (typeof PLAN_STATUSES)[number];
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];
export type SummaryScope = (typeof SUMMARY_SCOPES)[number];
