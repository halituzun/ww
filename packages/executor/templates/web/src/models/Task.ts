export type TaskStatus = 'pending' | 'completed';

export interface Task {
  readonly id: string;
  readonly title: string;
  readonly status: TaskStatus;
}

export function completeTask(task: Task): Task {
  if (task.status === 'completed') return task;
  return { ...task, status: 'completed' };
}
