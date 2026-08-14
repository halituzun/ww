import { describe, expect, it } from 'vitest';
import * as db from './index.js';

describe('@ww/db public repository surface', () => {
  it('Phase 2 repository ailelerinin temsilci APIlerini barrel uzerinden acar', () => {
    expect(db.createProject).toBeTypeOf('function');
    expect(db.appendMessage).toBeTypeOf('function');
    expect(db.appendReceiptVersion).toBeTypeOf('function');
    expect(db.appendEffectVersion).toBeTypeOf('function');
    expect(db.appendTaskBrief).toBeTypeOf('function');
    expect(db.appendTaskCausalEntry).toBeTypeOf('function');
    expect(db.appendEvent).toBeTypeOf('function');
    expect(db.appendArtifact).toBeTypeOf('function');
    expect(db.appendKnowledgeVersion).toBeTypeOf('function');
    expect(db.appendAuditFindingVersion).toBeTypeOf('function');
    expect(db.appendPromptVersion).toBeTypeOf('function');
    expect(db.RepositoryConflictError).toBeTypeOf('function');
  });
});
