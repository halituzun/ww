import { describe, expect, it } from 'vitest';
import * as db from './index.js';

describe('@ww/db public repository surface', () => {
  it('Phase 2 repository ailelerinin temsilci APIlerini barrel uzerinden acar', () => {
    expect(db.createProject).toBeTypeOf('function');
    expect(db.appendMessage).toBeTypeOf('function');
    expect(db.listDueInboxItems).toBeTypeOf('function');
    expect(db.findAuthoritativeAnswerWinner).toBeTypeOf('function');
    expect(db.listProtocolV1RepliesToMessage).toBeTypeOf('function');
    expect(db.listProtocolV1AnswerRepliesToMessage).toBeTypeOf('function');
    expect(db.appendReceiptVersion).toBeTypeOf('function');
    expect(db.listDueMessageReceiptCandidates).toBeTypeOf('function');
    expect(db.listTerminalReceiptEventCandidates).toBeTypeOf('function');
    expect(db.quarantineDueMessageReceiptCandidate).toBeTypeOf('function');
    expect(db.listLatestReceiptsByMessage).toBeTypeOf('function');
    expect(db.appendEffectVersion).toBeTypeOf('function');
    expect(db.appendTaskBrief).toBeTypeOf('function');
    expect(db.appendTaskCausalEntry).toBeTypeOf('function');
    expect(db.getTaskDurableMaxLeaseFence).toBeTypeOf('function');
    expect(db.listLatestTaskEffectsByStates).toBeTypeOf('function');
    expect(db.getEffectDurableMaxLeaseFence).toBeTypeOf('function');
    expect(db.reserveEffectWithEvidence).toBeTypeOf('function');
    expect(db.effectLockKey).toBeTypeOf('function');
    expect(db.getActualModelRefForInvocation).toBeTypeOf('function');
    expect(db.transferOrAcquireFileLocks).toBeTypeOf('function');
    expect(db.appendEvent).toBeTypeOf('function');
    expect(db.appendArtifact).toBeTypeOf('function');
    expect(db.appendKnowledgeVersion).toBeTypeOf('function');
    expect(db.getPlanAsOf).toBeTypeOf('function');
    expect(db.appendAgentVersion).toBeTypeOf('function');
    expect(db.listLatestAgents).toBeTypeOf('function');
    expect(db.appendAuditFindingVersion).toBeTypeOf('function');
    expect(db.appendPromptVersion).toBeTypeOf('function');
    expect(db.RepositoryConflictError).toBeTypeOf('function');
  });
});
