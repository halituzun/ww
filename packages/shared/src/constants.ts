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

export const EVENT_TYPES = [
  'tool_call', 'tool_result', 'api_call', 'decision', 'status_change', 'error',
  'commit', 'lock_acquired', 'lock_released', 'escalation', 'clone_spawned',
  'test_run', 'process_started', 'process_stopped', 'recovery_completed',
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
export const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type AgentStatus = (typeof AGENT_STATUSES)[number];
export type AgentRole = (typeof AGENT_ROLES)[number];
export type AgentGroup = (typeof AGENT_GROUPS)[number];
export type MessageKind = (typeof MESSAGE_KINDS)[number];
export type EventType = (typeof EVENT_TYPES)[number];
export type ProjectType = (typeof PROJECT_TYPES)[number];
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export type PlanStatus = (typeof PLAN_STATUSES)[number];
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];
export type SummaryScope = (typeof SUMMARY_SCOPES)[number];
