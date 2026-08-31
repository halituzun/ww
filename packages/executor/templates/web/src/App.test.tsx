import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import App from './App.js';
import { TaskService } from './services/TaskService.js';

describe('starter task flow', () => {
  it('completes a task and persists the new state', () => {
    let serialized: string | null = null;
    const service = new TaskService({
      getItem: () => serialized,
      setItem: (_key, value) => {
        serialized = value;
      },
    });

    render(<App service={service} />);

    fireEvent.click(screen.getByRole('button', { name: 'Mark complete' }));

    const completedButton = screen.getByRole('button', { name: 'Completed' });
    expect((completedButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('1/1 complete')).toBeTruthy();
    expect(serialized).toContain('completed');
  });
});
