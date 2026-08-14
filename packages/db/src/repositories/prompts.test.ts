import { canonicalSha256V1 } from '@ww/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCh, type ClickHouseClient } from '../client.js';
import { runMigrations } from '../migrate.js';
import { clickhouseUp } from '../testutil.js';
import {
  activatePromptVersion,
  appendPromptVersion,
  getActivePrompt,
  getActivePromptAsOf,
  getPromptSourceRefAsOf,
  getPromptVersion,
  getPromptVersionAsOf,
  setPromptVersionActive,
  type PromptRow,
} from './prompts.js';
import { RepositoryConflictError } from './types.js';

const up = await clickhouseUp();
describe.skipIf(!up)('prompts repository', () => {
  const db = `ww_test_prompts_${Date.now()}_${process.pid}`;
  let ch: ClickHouseClient;
  const rowHash = (row: PromptRow): string => canonicalSha256V1([
    row.prompt_name, String(row.prompt_version), row.content, [...row.variables],
    row.changelog, row.is_active ? '1' : '0', row.created_at, row.version,
  ]);
  beforeAll(async () => { await runMigrations({ database: db }); ch = createCh({ database: db }); });
  afterAll(async () => {
    const admin = createCh({ database: 'default' });
    await admin.command({ query: `DROP DATABASE IF EXISTS ${db}` });
    await admin.close(); await ch.close();
  });

  it('aktivasyon gecisini tek effective zamanla append eder ve as-of gelecegi sizdirmaz', async () => {
    expect((await getActivePrompt(ch, 'role.pm'))?.prompt_version).toBe(2);
    const createdAt = '2090-01-01T00:00:00.000Z';
    const beforeTransition = '2090-01-01T00:00:01.000Z';
    const changedAt = '2090-01-01T00:00:02.000Z';
    const afterTransition = '2090-01-01T00:00:03.000Z';
    const input = {
      prompt_name: 'role.pm', prompt_version: 3, content: 'PM v3 {{project_name}}',
      variables: ['project_name'], changelog: 'v3', is_active: false,
      created_at: createdAt,
    };
    const v3 = await appendPromptVersion(ch, input);
    expect(await appendPromptVersion(ch, input)).toEqual(v3);
    const activated = await activatePromptVersion(ch, 'role.pm', 3, changedAt);
    expect(activated.created_at).toBe(changedAt);
    await ch.command({ query: 'OPTIMIZE TABLE prompts FINAL' });
    expect((await getActivePrompt(ch, 'role.pm'))?.prompt_version).toBe(3);
    expect((await getPromptVersion(ch, 'role.pm', 2))?.is_active).toBe(false);
    expect((await getActivePromptAsOf(ch, 'role.pm', beforeTransition))?.prompt_version).toBe(2);
    expect((await getActivePromptAsOf(ch, 'role.pm', afterTransition))?.prompt_version).toBe(3);
    expect((await getPromptVersionAsOf(ch, 'role.pm', 3, beforeTransition))?.is_active)
      .toBe(false);
    expect((await getPromptVersionAsOf(ch, 'role.pm', 3, afterTransition))?.is_active)
      .toBe(true);
    const beforeRef = await getPromptSourceRefAsOf(ch, 'role.pm', 3, beforeTransition);
    const afterRef = await getPromptSourceRefAsOf(ch, 'role.pm', 3, afterTransition);
    expect(beforeRef?.hash).not.toBe(afterRef?.hash);
  });

  it('ayni row version icin divergent prompt tie kaydini fail-closed reddeder', async () => {
    const row = await appendPromptVersion(ch, {
      prompt_name: 'role.test.collision',
      prompt_version: 1,
      content: 'original',
      variables: [],
      changelog: 'initial',
      is_active: false,
      created_at: '2091-01-01T00:00:00.000Z',
    });
    const divergent = { ...row, content: 'divergent' };
    await ch.insert({
      table: 'prompts',
      values: [{ ...divergent, is_active: 0, row_hash: rowHash(divergent) }],
      format: 'JSONEachRow',
    });
    await ch.command({ query: 'OPTIMIZE TABLE prompts FINAL' });
    await expect(getPromptVersion(ch, row.prompt_name, row.prompt_version))
      .rejects.toBeInstanceOf(RepositoryConflictError);
    await expect(getActivePrompt(ch, row.prompt_name))
      .rejects.toBeInstanceOf(RepositoryConflictError);
  });

  it('prompt transition retryini yalniz eski expected surum ve exact changedAt ile kabul eder', async () => {
    const initial = await appendPromptVersion(ch, {
      prompt_name: 'role.test.transition-retry',
      prompt_version: 1,
      content: 'retry prompt',
      variables: [],
      changelog: 'initial',
      is_active: false,
      created_at: '2092-01-01T00:00:00.000Z',
    });
    const changedAt = '2092-01-01T00:00:01.000Z';
    const activated = await setPromptVersionActive(
      ch,
      initial.prompt_name,
      initial.prompt_version,
      true,
      initial.version,
      changedAt,
    );
    expect(await setPromptVersionActive(
      ch,
      initial.prompt_name,
      initial.prompt_version,
      true,
      initial.version,
      changedAt,
    )).toEqual(activated);
    await expect(setPromptVersionActive(
      ch,
      initial.prompt_name,
      initial.prompt_version,
      true,
      (BigInt(activated.version) + 1n).toString(),
      changedAt,
    )).rejects.toBeInstanceOf(RepositoryConflictError);
  });
});
