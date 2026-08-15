import { describe, expect, it } from 'vitest';
import { ExecutorError } from './errors.js';
import { TOOL_NAMES, executorToolRegistry } from './tool-registry.js';

describe('ToolRegistry', () => {
  it('sekiz JSON şemasını bir kez derler ve providera aynı nesneyi verir', () => {
    expect(executorToolRegistry.definitions().map((tool) => tool.name)).toEqual(TOOL_NAMES);
    for (const name of TOOL_NAMES) {
      const first = executorToolRegistry.definition(name);
      const second = executorToolRegistry.definition(name);
      expect(first.parameters).toBe(second.parameters);
      expect(Object.isFrozen(first.parameters)).toBe(true);
      expect(executorToolRegistry.validator(name)).toBe(executorToolRegistry.validator(name));
    }
  });

  it('bilinmeyen alanı ve gevşek verdict biçimini fail-closed reddeder', () => {
    expect(() => executorToolRegistry.parseArguments('read_file', {
      path: 'src/a.ts',
      unexpected: true,
    })).toThrowError(ExecutorError);
    expect(() => executorToolRegistry.parseArguments('submit_verdict', {
      decision: 'APPROVE',
      reasons: [],
      evidenceRefs: [],
      ruleRefs: [],
    })).toThrow(/geçersiz/);
  });

  it('strict structured verdicti kabul eder', () => {
    const args = {
      decision: 'approve',
      reasons: [{ message: 'Kanıt yeterli', evidenceRefs: ['diff:1'] }],
      evidenceRefs: ['gate:1'],
      ruleRefs: [{ ruleId: 'TOOL-001', ruleVersion: 1 }],
    };
    expect(executorToolRegistry.parseArguments('submit_verdict', args)).toBe(args);
  });
});
