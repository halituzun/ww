import { canonicalSha256V1 } from '@ww/shared';
import {
  RepositoryConflictError,
  appendEvent,
  getEvent,
  type AppendEventInput,
  type ClickHouseClient,
  type EventRow,
} from '@ww/db';

function assertExactEvent(expected: AppendEventInput, observed: EventRow): EventRow {
  if (canonicalSha256V1(expected) !== canonicalSha256V1(observed)) {
    throw new RepositoryConflictError(
      `event:${expected.event_id} immutable kimlik/hash catismasi`,
    );
  }
  return observed;
}

/**
 * Ensures a deterministic audit event without adding a physical duplicate on replay.
 * One transient boundary failure is reconciled from ClickHouse and retried when absent.
 */
export async function ensureDurableEvent(
  ch: ClickHouseClient,
  expected: AppendEventInput,
): Promise<EventRow> {
  const existing = await getEvent(ch, expected.event_id);
  if (existing !== null) return assertExactEvent(expected, existing);
  try {
    return await appendEvent(ch, expected);
  } catch (error) {
    const reconciled = await getEvent(ch, expected.event_id);
    if (reconciled !== null) return assertExactEvent(expected, reconciled);
    try {
      return await appendEvent(ch, expected);
    } catch (retryError) {
      const retried = await getEvent(ch, expected.event_id);
      if (retried !== null) return assertExactEvent(expected, retried);
      throw retryError instanceof Error ? retryError : error;
    }
  }
}
