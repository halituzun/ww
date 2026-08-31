import { expect, it } from 'vitest';
import {
  AGENT_ROLES,
  EVENT_TYPES,
  MESSAGE_KINDS,
  PROMPT_MESSAGE_ROLES,
  TASK_STATUSES,
} from './constants.js';

it('durum/rol/olay listeleri tekildir', () => {
  for (const list of [
    TASK_STATUSES,
    AGENT_ROLES,
    MESSAGE_KINDS,
    PROMPT_MESSAGE_ROLES,
    EVENT_TYPES,
  ]) {
    expect(new Set(list).size).toBe(list.length);
  }
});
