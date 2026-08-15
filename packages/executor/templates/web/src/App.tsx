import { useMemo } from 'react';
import { TaskService } from './services/TaskService.js';
import { useTaskListViewModel } from './viewmodels/useTaskListViewModel.js';
import { TaskListView } from './views/tasks/TaskListView.js';

export interface AppProps {
  readonly service?: TaskService;
}

export default function App({ service: configuredService }: AppProps) {
  const service = useMemo(
    () => configuredService ?? new TaskService(window.localStorage),
    [configuredService],
  );
  const viewModel = useTaskListViewModel(service);

  return <TaskListView {...viewModel} />;
}
