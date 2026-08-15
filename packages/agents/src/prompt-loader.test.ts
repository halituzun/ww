import { describe, expect, it } from 'vitest';
import { SealedPromptLoader } from './prompt-loader.js';

describe('sealed prompt loader', () => {
  it('command/question/diff/summary malzemesini loop tekrarına izin vermeden bir kez yükler', () => {
    const loader = new SealedPromptLoader();
    const snapshot = { promptMessages: [{ role: 'system', content: 'base' }] } as never;
    const pm = loader.loadPm({ snapshot, command: 'COMMAND-ONCE', question: 'QUESTION-ONCE' });
    expect(pm.filter((message) => message.content === 'COMMAND-ONCE')).toHaveLength(1);
    expect(pm.filter((message) => message.content === 'QUESTION-ONCE')).toHaveLength(1);
    const verifier = loader.loadVerifier({ brief: {} as never, snapshot, diff: 'DIFF-ONCE', summary: 'SUMMARY-ONCE' });
    expect(verifier.filter((message) => message.content.includes('DIFF-ONCE'))).toHaveLength(1);
  });
});
