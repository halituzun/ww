import { useState } from 'react';
import { completeTask, type Task } from '../models/Task.js';
import type { TaskService } from '../services/TaskService.js';

export interface TaskListViewModel {
  readonly tasks: readonly Task[];
  readonly completedCount: number;
  readonly onComplete: (taskId: string) => void;
}

export function useTaskListViewModel(service: TaskService): TaskListViewModel {
  const [tasks, setTasks] = useState<readonly Task[]>(() => service.list());

  const onComplete = (taskId: string): void => {
    setTasks((currentTasks) => {
      const nextTasks = currentTasks.map((task) =>
        task.id === taskId ? completeTask(task) : task,
      );
      service.save(nextTasks);
      return nextTasks;
    });
  };

  return {
    tasks,
    completedCount: tasks.filter((task) => task.status === 'completed').length,
    onComplete,
  };
}
