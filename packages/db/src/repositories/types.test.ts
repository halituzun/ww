import { describe, expect, it } from 'vitest';
import {
  RepositoryConflictError,
  RepositoryWriteError,
  StoredRecordError,
  EmptyAcknowledgedWriteVerificationError,
  nextRepositoryVersion,
  readAfterAcknowledgedWrite,
  readAfterUncertainWrite,
  readRowsAfterAcknowledgedWrite,
  reconcileVersionedWrite,
  storedJsonObject,
  type AcknowledgedWriteVerificationCause,
  type UncertainWriteCause,
} from './types.js';

describe('repository ortak tipleri', () => {
  it('ilk surumu ve onceki kalici surumun deterministic ardilini uretir', () => {
    expect(nextRepositoryVersion()).toBe('1');
    expect(nextRepositoryVersion('00041')).toBe('42');
    expect(nextRepositoryVersion('41')).toBe('42');
  });

  it('UInt64 surum alani tasmasini fail-closed reddeder', () => {
    expect(() => nextRepositoryVersion('18446744073709551615')).toThrow(
      RepositoryConflictError,
    );
  });

  it('ayni surumde esit retry satirlarini uzlastirir', () => {
    const expected = { version: '42', state: 'queued' } as const;
    expect(reconcileVersionedWrite('task:t1', expected, [expected, { ...expected }])).toBe(expected);
  });

  it('ayni kimlik ve surumde farkli icerigi collision olarak reddeder', () => {
    const expected = { version: '42', state: 'queued' } as const;
    expect(() => reconcileVersionedWrite(
      'task:t1',
      expected,
      [{ version: '42', state: 'working' }],
    )).toThrow(RepositoryConflictError);
  });

  it('kalici JSON alanlarini strict shared JSON sinirinda parse eder', () => {
    expect(storedJsonObject('{"nested":{"ok":true}}', 'projects.settings')).toEqual({
      nested: { ok: true },
    });
    expect(() => storedJsonObject('{"constructor":{}}', 'projects.settings')).toThrow(
      StoredRecordError,
    );
  });

  it('belirsiz insert sonrasi reconciliation okuma hatasini typed cause ile sarar', async () => {
    const insert = new Error('insert timeout');
    const reconciliation = new Error('read unavailable');

    const promise = readAfterUncertainWrite('project:p1', insert, async () => {
      throw reconciliation;
    });

    await expect(promise).rejects.toSatisfy((error: unknown) => {
      if (!(error instanceof RepositoryWriteError)) return false;
      const cause = error.cause as UncertainWriteCause;
      return cause.insert === insert && cause.reconciliation === reconciliation &&
        error.message.includes('project:p1');
    });
  });

  it('onaylanan insert dogrulama hatasini commit-likely deterministic kimlikle sarar', async () => {
    const verification = new Error('verification unavailable');
    const operation = { projectId: 'p1', version: '42' };
    const verify = () => readAfterAcknowledgedWrite('project:p1', operation, async () => {
      throw verification;
    });

    const first = await verify().catch((error: unknown) => error);
    const second = await verify().catch((error: unknown) => error);
    expect(first).toBeInstanceOf(RepositoryWriteError);
    const firstCause = (first as RepositoryWriteError).cause as AcknowledgedWriteVerificationCause;
    const secondCause = (second as RepositoryWriteError).cause as AcknowledgedWriteVerificationCause;
    expect(firstCause).toMatchObject({ commitLikely: true, verification });
    expect(firstCause.operationIdentity).toMatch(/^[0-9a-f]{64}$/);
    expect(secondCause.operationIdentity).toBe(firstCause.operationIdentity);
  });

  it('post-ack callback domain conflictini error taxonomy degistirmeden iletir', async () => {
    const conflict = new RepositoryConflictError('same-version collision');
    await expect(readAfterAcknowledgedWrite('project:p1', {}, async () => {
      throw conflict;
    })).rejects.toBe(conflict);
  });

  it('post-ack bos rereadi commit-likely verification failure olarak siniflar', async () => {
    const failure = await readRowsAfterAcknowledgedWrite(
      'artifact:a1',
      { artifactId: 'a1' },
      async () => [],
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RepositoryWriteError);
    const cause = (failure as RepositoryWriteError).cause as AcknowledgedWriteVerificationCause;
    expect(cause.commitLikely).toBe(true);
    expect(cause.verification).toBeInstanceOf(EmptyAcknowledgedWriteVerificationError);
  });
});
