import { describe, expect, it } from 'vitest';
import { InterviewService } from './interview-service.js';

describe('InterviewService', () => {
  it('requires the bounded wizard questions before completion', () => {
    const service = new InterviewService();
    const session = service.start('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
    const complete = service.answer(service.answer(session, 'goal', 'todo app'), 'users', 'team');
    expect(complete.complete).toBe(true);
    expect(complete.snapshotHash).not.toBe(session.snapshotHash);
  });
});
