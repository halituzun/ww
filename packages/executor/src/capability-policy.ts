import {
  ToolCapabilityV1Schema,
  type PolicyDecision,
  type ToolCapabilityV1,
} from '@ww/shared';
import { ExecutorError } from './errors.js';
import type { ExecutorContext } from './ports.js';
import { normalizeWorkspaceRelativePath } from './workspace-paths.js';
import type { ToolName } from './tool-registry.js';

const ACTIVE_TOOL_STATUSES = ['assigned', 'working', 'verifying', 'testing'] as const;

function capability(input: ToolCapabilityV1): ToolCapabilityV1 {
  return Object.freeze(ToolCapabilityV1Schema.parse(input));
}

export const EXECUTOR_TOOL_CAPABILITIES: Readonly<Record<ToolName, ToolCapabilityV1>> = Object.freeze({
  read_file: capability({
    toolName: 'read_file', rule: { ruleId: 'TOOL-002', ruleVersion: 1 },
    allowedRoles: ['worker', 'verifier'], allowedTaskStatuses: ACTIVE_TOOL_STATUSES,
    requiresDeclaredTarget: true, requiresFileLock: false, replaySafety: 'replay_safe',
  }),
  list_dir: capability({
    // GÖRME aracıdır: mühürlü hedef listesi YAZMAYI sınırlar, görmeyi değil.
    // `requiresDeclaredTarget: true` verilseydi worker yalnızca zaten bildiği
    // dosyaları listeleyebilirdi ve araç anlamsız olurdu.
    toolName: 'list_dir', rule: { ruleId: 'TOOL-002', ruleVersion: 1 },
    allowedRoles: ['worker', 'verifier'], allowedTaskStatuses: ACTIVE_TOOL_STATUSES,
    requiresDeclaredTarget: false, requiresFileLock: false, replaySafety: 'replay_safe',
  }),
  search_code: capability({
    // `list_dir` gibi GÖRME aracıdır; hedef listesi görmeyi sınırlamaz.
    toolName: 'search_code', rule: { ruleId: 'TOOL-002', ruleVersion: 1 },
    allowedRoles: ['worker', 'verifier'], allowedTaskStatuses: ACTIVE_TOOL_STATUSES,
    requiresDeclaredTarget: false, requiresFileLock: false, replaySafety: 'replay_safe',
  }),
  create_subtask: capability({
    // Alt görev açmak DURUM DEĞİŞTİRİR ve kaynak harcar; yalnızca çalışan
    // görevde ve worker rolünde açılabilir. Hedef dosya listesi ARAÇ
    // ARGÜMANINDADIR, ebeveynin mühürlü listesi değil: alt görev başka
    // dosyalara bakabilir (sınırları zamanlayıcı uygular).
    toolName: 'create_subtask', rule: { ruleId: 'TASK-004', ruleVersion: 1 },
    allowedRoles: ['worker'], allowedTaskStatuses: ['working'],
    requiresDeclaredTarget: false, requiresFileLock: false,
    // Aynı çağrı iki kez alt görev AÇMAMALIDIR; idempotency çağrı kimliğinden
    // gelir ve tekrar güvenli sayılmaz.
    replaySafety: 'non_replay_safe',
  }),
  memory_query: capability({
    // GÖRME aracıdır ve YAN ETKİSİ YOKTUR; hedef listesi onu sınırlamaz.
    toolName: 'memory_query', rule: { ruleId: 'TOOL-002', ruleVersion: 1 },
    allowedRoles: ['worker', 'verifier'], allowedTaskStatuses: ACTIVE_TOOL_STATUSES,
    requiresDeclaredTarget: false, requiresFileLock: false, replaySafety: 'replay_safe',
  }),
  record_knowledge: capability({
    // YAZAR: proje belleğine kalıcı kayıt düşer. Tekrar güvenli DEĞİLDİR —
    // aynı çağrının iki kez yazması aynı kararı iki kez kaydeder.
    toolName: 'record_knowledge', rule: { ruleId: 'TASK-004', ruleVersion: 1 },
    allowedRoles: ['worker'], allowedTaskStatuses: ['working'],
    requiresDeclaredTarget: false, requiresFileLock: false,
    replaySafety: 'non_replay_safe',
  }),
  record_artifact: capability({
    // Üretilen çıktının kaydı; dosya yolu MÜHÜRLÜ hedeflerden olmalıdır,
    // yoksa agent üretmediği bir dosyayı kendi çıktısı gibi kaydedebilir.
    toolName: 'record_artifact', rule: { ruleId: 'TASK-004', ruleVersion: 1 },
    allowedRoles: ['worker'], allowedTaskStatuses: ['working'],
    requiresDeclaredTarget: true, requiresFileLock: false,
    replaySafety: 'non_replay_safe',
  }),
  write_file: capability({
    toolName: 'write_file', rule: { ruleId: 'TOOL-003', ruleVersion: 1 },
    allowedRoles: ['worker'], allowedTaskStatuses: ['working'],
    requiresDeclaredTarget: true, requiresFileLock: true, replaySafety: 'replay_safe',
  }),
  edit_file: capability({
    toolName: 'edit_file', rule: { ruleId: 'TOOL-003', ruleVersion: 1 },
    allowedRoles: ['worker'], allowedTaskStatuses: ['working'],
    requiresDeclaredTarget: true, requiresFileLock: true, replaySafety: 'replay_safe',
  }),
  run_command: capability({
    toolName: 'run_command', rule: { ruleId: 'TOOL-004', ruleVersion: 1 },
    allowedRoles: ['worker'], allowedTaskStatuses: ['working'],
    requiresDeclaredTarget: false, requiresFileLock: false, replaySafety: 'non_replay_safe',
  }),
  git_diff: capability({
    toolName: 'git_diff', rule: { ruleId: 'TOOL-004', ruleVersion: 1 },
    allowedRoles: ['worker', 'verifier'], allowedTaskStatuses: ACTIVE_TOOL_STATUSES,
    requiresDeclaredTarget: false, requiresFileLock: false, replaySafety: 'replay_safe',
  }),
  ask_question: capability({
    toolName: 'ask_question', rule: { ruleId: 'COMM-001', ruleVersion: 1 },
    allowedRoles: ['worker', 'verifier'], allowedTaskStatuses: ['working', 'verifying'],
    requiresDeclaredTarget: false, requiresFileLock: false, replaySafety: 'replay_safe',
  }),
  report_result: capability({
    toolName: 'report_result', rule: { ruleId: 'TASK-002', ruleVersion: 1 },
    allowedRoles: ['worker'], allowedTaskStatuses: ['working'],
    requiresDeclaredTarget: false, requiresFileLock: false, replaySafety: 'replay_safe',
  }),
  submit_verdict: capability({
    toolName: 'submit_verdict', rule: { ruleId: 'TASK-002', ruleVersion: 1 },
    allowedRoles: ['verifier'], allowedTaskStatuses: ['verifying'],
    requiresDeclaredTarget: false, requiresFileLock: false, replaySafety: 'replay_safe',
  }),
});

function deny(ruleId: ToolCapabilityV1['rule']['ruleId'], reason: string, evidenceRefs: string[]): never {
  const decision: PolicyDecision = Object.freeze({
    ruleId,
    ruleVersion: 1,
    allowed: false,
    reason,
    evidenceRefs: Object.freeze(evidenceRefs),
  });
  throw new ExecutorError('CAPABILITY_DENIED', reason, { decision });
}

export function authorizeTool(
  context: ExecutorContext,
  toolName: ToolName,
  relativePath?: string,
): PolicyDecision {
  const configured = EXECUTOR_TOOL_CAPABILITIES[toolName];
  const evidence = [`task:${context.brief.taskId}`, `attempt:${context.attempt.assignmentAttemptId}`];
  if (
    context.brief.projectId !== context.attempt.projectId ||
    context.brief.taskId !== context.attempt.taskId ||
    context.brief.taskBriefId !== context.attempt.taskBriefId
  ) {
    deny('TOOL-001', 'Brief ve assignment attempt aynı görev bağlamına ait değil', evidence);
  }
  const assignedAgent = context.agentRole === 'worker'
    ? context.attempt.workerAgentId
    : context.agentRole === 'verifier'
      ? context.attempt.verifierAgentId
      : undefined;
  if (assignedAgent !== context.agentId) {
    deny('TOOL-001', 'Agent current assignment içinde yetkili değil', evidence);
  }
  if (!configured.allowedRoles.includes(context.agentRole)) {
    deny(configured.rule.ruleId, `${context.agentRole} rolü ${toolName} kullanamaz`, evidence);
  }
  if (!configured.allowedTaskStatuses.includes(context.taskStatus)) {
    deny(configured.rule.ruleId, `${toolName} ${context.taskStatus} durumunda kullanılamaz`, evidence);
  }
  if (!context.brief.allowedTools.includes(toolName)) {
    deny('TOOL-001', `${toolName} mühürlü brief içinde izinli değil`, evidence);
  }
  if (configured.requiresDeclaredTarget) {
    if (relativePath === undefined) {
      deny('TOOL-002', `${toolName} workspace hedef yolu gerektirir`, evidence);
    }
    const normalized = normalizeWorkspaceRelativePath(relativePath);
    const declared = new Set(context.brief.targetFiles.map((target) => {
      const canonical = normalizeWorkspaceRelativePath(target);
      if (canonical !== target) {
        deny('TOOL-002', `Brief canonical olmayan hedef taşıyor: ${target}`, evidence);
      }
      return canonical;
    }));
    if (!declared.has(normalized)) {
      deny('TOOL-002', `${normalized} mühürlü görev hedeflerinde değil`, [...evidence, `path:${normalized}`]);
    }
  }
  return Object.freeze({
    ruleId: configured.rule.ruleId,
    ruleVersion: configured.rule.ruleVersion,
    allowed: true,
    reason: `${toolName} capability doğrulandı`,
    evidenceRefs: Object.freeze(evidence),
  });
}
