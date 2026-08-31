import type { Task } from '../models/Task.js';

const STORAGE_KEY = 'ww-web-starter.tasks';
const INITIAL_TASKS: readonly Task[] = Object.freeze([
  Object.freeze({
    id: 'explore-starter',
    title: 'Explore the MVVM starter',
    status: 'pending',
  }),
]);

function isTask(value: unknown): value is Task {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['id'] === 'string' &&
    typeof candidate['title'] === 'string' &&
    (candidate['status'] === 'pending' || candidate['status'] === 'completed')
  );
}

export class TaskService {
  public constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'>,
  ) {}

  public list(): readonly Task[] {
    const serialized = this.storage.getItem(STORAGE_KEY);
    if (serialized === null) return INITIAL_TASKS;

    try {
      const parsed: unknown = JSON.parse(serialized);
      return Array.isArray(parsed) && parsed.every(isTask)
        ? parsed
        : INITIAL_TASKS;
    } catch (error: unknown) {
      if (error instanceof SyntaxError) return INITIAL_TASKS;
      throw error;
    }
  }

  public save(tasks: readonly Task[]): void {
    this.storage.setItem(STORAGE_KEY, JSON.stringify(tasks));
  }
}
