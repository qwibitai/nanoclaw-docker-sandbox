import { vi } from 'vitest';

vi.mock('./container-runner.js', () => ({
  runContainerAgent: vi.fn(),
  writeTasksSnapshot: vi.fn(),
}));

vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: vi.fn((folder: string) => {
    if (folder.startsWith('..')) throw new Error(`Invalid path: ${folder}`);
    return `/tmp/claude/test-groups/${folder}`;
  }),
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase, createTask, getTaskById } from './db.js';
import {
  _resetSchedulerLoopForTests,
  computeNextRun,
  startSchedulerLoop,
} from './task-scheduler.js';

describe('task scheduler', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pauses due tasks with invalid group folders to prevent retry churn', async () => {
    createTask({
      id: 'task-invalid-folder',
      group_folder: '../../outside',
      chat_jid: 'bad@g.us',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      // biome-ignore lint/suspicious/noExplicitAny: partial mock for test
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('task-invalid-folder');
    expect(task?.status).toBe('paused');
  });

  it('computeNextRun anchors interval tasks to scheduled time to prevent drift', () => {
    const scheduledTime = new Date(Date.now() - 2000).toISOString(); // 2s ago
    const task = {
      id: 'drift-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: '60000', // 1 minute
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();

    // Should be anchored to scheduledTime + 60s, NOT Date.now() + 60s
    const expected = new Date(scheduledTime).getTime() + 60000;
    // biome-ignore lint/style/noNonNullAssertion: guarded by expect(nextRun).not.toBeNull() above
    expect(new Date(nextRun!).getTime()).toBe(expected);
  });

  it('computeNextRun returns null for once-tasks', () => {
    const task = {
      id: 'once-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'once' as const,
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated' as const,
      next_run: new Date(Date.now() - 1000).toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    expect(computeNextRun(task)).toBeNull();
  });

  it('computeNextRun skips missed intervals without infinite loop', () => {
    // Task was due 10 intervals ago (missed)
    const ms = 60000;
    const missedBy = ms * 10;
    const scheduledTime = new Date(Date.now() - missedBy).toISOString();

    const task = {
      id: 'skip-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: String(ms),
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    // Must be in the future
    // biome-ignore lint/style/noNonNullAssertion: guarded by expect(nextRun).not.toBeNull() above
    expect(new Date(nextRun!).getTime()).toBeGreaterThan(Date.now());
    // Must be aligned to the original schedule grid
    // biome-ignore lint/style/noNonNullAssertion: guarded by expect(nextRun).not.toBeNull() above
    const nextRunTime = new Date(nextRun!).getTime();
    const offset = (nextRunTime - new Date(scheduledTime).getTime()) % ms;
    expect(offset).toBe(0);
  });

  it('computeNextRun returns a future ISO string for cron tasks', () => {
    const task = {
      id: 'cron-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'cron' as const,
      schedule_value: '0 * * * *', // every hour on the hour
      context_mode: 'isolated' as const,
      next_run: new Date().toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: guarded by not.toBeNull()
    expect(new Date(nextRun!).getTime()).toBeGreaterThan(Date.now());
  });

  it('runTask does not call runContainerAgent when group is not registered', async () => {
    const { runContainerAgent } = await import('./container-runner.js');

    createTask({
      id: 'task-no-group',
      group_folder: 'missing-group',
      chat_jid: 'missing@g.us',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (_jid: string, _id: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      // biome-ignore lint/suspicious/noExplicitAny: partial mock for test
      queue: { enqueueTask, closeStdin: vi.fn(), notifyIdle: vi.fn() } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(vi.mocked(runContainerAgent)).not.toHaveBeenCalled();
  });

  it('runTask calls runContainerAgent when group is registered', async () => {
    const { runContainerAgent } = await import('./container-runner.js');
    vi.mocked(runContainerAgent).mockResolvedValueOnce({
      status: 'success' as const,
      result: 'done',
      // biome-ignore lint/suspicious/noExplicitAny: partial mock
    } as any);

    createTask({
      id: 'task-registered',
      group_folder: 'my-group',
      chat_jid: 'my@g.us',
      prompt: 'run it',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (_jid: string, _id: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({
        'my@g.us': {
          name: 'My Group',
          folder: 'my-group',
          trigger: 'always',
          added_at: '2026-01-01T00:00:00.000Z',
          isMain: false,
        },
      }),
      getSessions: () => ({}),
      // biome-ignore lint/suspicious/noExplicitAny: partial mock for test
      queue: { enqueueTask, closeStdin: vi.fn(), notifyIdle: vi.fn() } as any,
      onProcess: () => {},
      sendMessage: vi.fn().mockResolvedValue(undefined),
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(vi.mocked(runContainerAgent)).toHaveBeenCalledOnce();
  });

  it('runTask forwards result to sendMessage via streaming callback', async () => {
    const { runContainerAgent } = await import('./container-runner.js');
    vi.mocked(runContainerAgent).mockImplementationOnce(
      // biome-ignore lint/suspicious/noExplicitAny: test mock captures streaming callback
      async (_g: any, _o: any, _p: any, onOutput: any) => {
        await onOutput({ result: 'Task complete', status: 'success' });
        return { status: 'success' as const, result: 'Task complete' };
      },
    );

    createTask({
      id: 'task-stream',
      group_folder: 'my-group',
      chat_jid: 'my@g.us',
      prompt: 'run it',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const closeStdin = vi.fn();
    const enqueueTask = vi.fn(
      (_jid: string, _id: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({
        'my@g.us': {
          name: 'My Group',
          folder: 'my-group',
          trigger: 'always',
          added_at: '2026-01-01T00:00:00.000Z',
          isMain: false,
        },
      }),
      getSessions: () => ({}),
      // biome-ignore lint/suspicious/noExplicitAny: partial mock for test
      queue: { enqueueTask, closeStdin, notifyIdle: vi.fn() } as any,
      onProcess: () => {},
      sendMessage,
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(sendMessage).toHaveBeenCalledWith('my@g.us', 'Task complete');
  });

  it('runTask updates task last_result after successful run', async () => {
    const { runContainerAgent } = await import('./container-runner.js');
    vi.mocked(runContainerAgent).mockImplementationOnce(
      // biome-ignore lint/suspicious/noExplicitAny: test mock captures streaming callback
      async (_g: any, _o: any, _p: any, onOutput: any) => {
        await onOutput({ result: 'Done!', status: 'success' });
        return { status: 'success' as const, result: 'Done!' };
      },
    );

    createTask({
      id: 'task-result',
      group_folder: 'my-group',
      chat_jid: 'my@g.us',
      prompt: 'run it',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (_jid: string, _id: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({
        'my@g.us': {
          name: 'My Group',
          folder: 'my-group',
          trigger: 'always',
          added_at: '2026-01-01T00:00:00.000Z',
          isMain: false,
        },
      }),
      getSessions: () => ({}),
      // biome-ignore lint/suspicious/noExplicitAny: partial mock for test
      queue: { enqueueTask, closeStdin: vi.fn(), notifyIdle: vi.fn() } as any,
      onProcess: () => {},
      sendMessage: vi.fn().mockResolvedValue(undefined),
    });

    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('task-result');
    expect(task?.last_result).toBe('Done!');
  });

  it('runTask captures streaming error and sets last_result to error summary', async () => {
    const { runContainerAgent } = await import('./container-runner.js');
    vi.mocked(runContainerAgent).mockImplementationOnce(
      // biome-ignore lint/suspicious/noExplicitAny: test mock captures streaming callback
      async (_g: any, _o: any, _p: any, onOutput: any) => {
        await onOutput({ status: 'error', result: null, error: 'container crashed' });
        return { status: 'error' as const, result: null, error: 'container crashed' };
      },
    );

    createTask({
      id: 'task-stream-err',
      group_folder: 'my-group',
      chat_jid: 'my@g.us',
      prompt: 'run it',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (_jid: string, _id: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({
        'my@g.us': {
          name: 'My Group',
          folder: 'my-group',
          trigger: 'always',
          added_at: '2026-01-01T00:00:00.000Z',
          isMain: false,
        },
      }),
      getSessions: () => ({}),
      // biome-ignore lint/suspicious/noExplicitAny: partial mock for test
      queue: { enqueueTask, closeStdin: vi.fn(), notifyIdle: vi.fn() } as any,
      onProcess: () => {},
      sendMessage: vi.fn().mockResolvedValue(undefined),
    });

    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('task-stream-err');
    expect(task?.last_result).toBe('Error: container crashed');
  });

  it('runTask captures thrown exception and sets last_result to error summary', async () => {
    const { runContainerAgent } = await import('./container-runner.js');
    vi.mocked(runContainerAgent).mockRejectedValueOnce(new Error('network timeout'));

    createTask({
      id: 'task-throw',
      group_folder: 'my-group',
      chat_jid: 'my@g.us',
      prompt: 'run it',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (_jid: string, _id: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({
        'my@g.us': {
          name: 'My Group',
          folder: 'my-group',
          trigger: 'always',
          added_at: '2026-01-01T00:00:00.000Z',
          isMain: false,
        },
      }),
      getSessions: () => ({}),
      // biome-ignore lint/suspicious/noExplicitAny: partial mock for test
      queue: { enqueueTask, closeStdin: vi.fn(), notifyIdle: vi.fn() } as any,
      onProcess: () => {},
      sendMessage: vi.fn().mockResolvedValue(undefined),
    });

    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('task-throw');
    expect(task?.last_result).toBe('Error: network timeout');
  });
});
