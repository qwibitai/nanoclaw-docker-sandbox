import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import { _initTestDatabase, setRegisteredGroup } from './db.js';
import { type IpcDeps, startIpcWatcher } from './ipc.js';
import type { RegisteredGroup } from './types.js';

const MAIN: RegisteredGroup = {
  name: 'Main',
  folder: 'main-group',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
};

const OTHER: RegisteredGroup = {
  name: 'Other',
  folder: 'other-group',
  trigger: '@bot',
  added_at: '2024-01-01T00:00:00.000Z',
};

let ipcBaseDir: string;
let deps: IpcDeps;

beforeEach(() => {
  _initTestDatabase();
  setRegisteredGroup('main@g.us', MAIN);
  setRegisteredGroup('other@g.us', OTHER);
  ipcBaseDir = path.join(os.tmpdir(), `ipc-poll-test-${process.pid}-${Date.now()}`);
  fs.mkdirSync(ipcBaseDir, { recursive: true });
  vi.useFakeTimers();
  deps = {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    registeredGroups: () => ({
      'main@g.us': MAIN,
      'other@g.us': OTHER,
    }),
    registerGroup: vi.fn(),
    syncGroups: vi.fn().mockResolvedValue(undefined),
    getAvailableGroups: vi.fn().mockReturnValue([]),
    writeGroupsSnapshot: vi.fn(),
  };
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(ipcBaseDir, { recursive: true, force: true });
});

describe('startIpcWatcher — message forwarding', () => {
  it('sends a message when an authorized IPC message file is present', async () => {
    const messagesDir = path.join(ipcBaseDir, 'other-group', 'messages');
    fs.mkdirSync(messagesDir, { recursive: true });
    fs.writeFileSync(
      path.join(messagesDir, '001.json'),
      JSON.stringify({ type: 'message', chatJid: 'other@g.us', text: 'hello' }),
    );

    startIpcWatcher(deps, ipcBaseDir);
    await vi.advanceTimersByTimeAsync(10);

    expect(deps.sendMessage).toHaveBeenCalledWith('other@g.us', 'hello');
    expect(fs.existsSync(path.join(messagesDir, '001.json'))).toBe(false);
  });

  it('blocks unauthorized IPC message (non-main sending to another group)', async () => {
    const messagesDir = path.join(ipcBaseDir, 'other-group', 'messages');
    fs.mkdirSync(messagesDir, { recursive: true });
    fs.writeFileSync(
      path.join(messagesDir, '002.json'),
      JSON.stringify({ type: 'message', chatJid: 'main@g.us', text: 'infiltrate' }),
    );

    startIpcWatcher(deps, ipcBaseDir);
    await vi.advanceTimersByTimeAsync(10);

    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(messagesDir, '002.json'))).toBe(false);
  });

  it('main group can send to any group', async () => {
    const messagesDir = path.join(ipcBaseDir, 'main-group', 'messages');
    fs.mkdirSync(messagesDir, { recursive: true });
    fs.writeFileSync(
      path.join(messagesDir, '003.json'),
      JSON.stringify({ type: 'message', chatJid: 'other@g.us', text: 'broadcast' }),
    );

    startIpcWatcher(deps, ipcBaseDir);
    await vi.advanceTimersByTimeAsync(10);

    expect(deps.sendMessage).toHaveBeenCalledWith('other@g.us', 'broadcast');
  });
});

describe('cleanupOrphanedPermissions', () => {
  it('writes deny response for each orphaned .processing file on startup', () => {
    const reqDir = path.join(ipcBaseDir, 'other-group', 'permissions', 'requests');
    const resDir = path.join(ipcBaseDir, 'other-group', 'permissions', 'responses');
    fs.mkdirSync(reqDir, { recursive: true });
    fs.mkdirSync(resDir, { recursive: true });

    fs.writeFileSync(
      path.join(reqDir, 'req-abc.processing'),
      JSON.stringify({ requestId: 'req-abc', chatJid: 'other@g.us' }),
    );

    // cleanupOrphanedPermissions runs synchronously at startup — write files BEFORE calling startIpcWatcher
    startIpcWatcher(deps, ipcBaseDir);

    const responseFile = path.join(resDir, 'req-abc.json');
    expect(fs.existsSync(responseFile)).toBe(true);
    const response = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
    expect(response).toEqual({ approved: false });
  });

  it('does not overwrite an existing response file', () => {
    const reqDir = path.join(ipcBaseDir, 'other-group', 'permissions', 'requests');
    const resDir = path.join(ipcBaseDir, 'other-group', 'permissions', 'responses');
    fs.mkdirSync(reqDir, { recursive: true });
    fs.mkdirSync(resDir, { recursive: true });

    fs.writeFileSync(
      path.join(reqDir, 'req-xyz.processing'),
      JSON.stringify({ requestId: 'req-xyz', chatJid: 'other@g.us' }),
    );
    fs.writeFileSync(
      path.join(resDir, 'req-xyz.json'),
      JSON.stringify({ approved: true }),
    );

    startIpcWatcher(deps, ipcBaseDir);

    const response = JSON.parse(
      fs.readFileSync(path.join(resDir, 'req-xyz.json'), 'utf-8'),
    );
    expect(response).toEqual({ approved: true });
  });

  it('ignores non-.processing files in requests dir', () => {
    const reqDir = path.join(ipcBaseDir, 'other-group', 'permissions', 'requests');
    const resDir = path.join(ipcBaseDir, 'other-group', 'permissions', 'responses');
    fs.mkdirSync(reqDir, { recursive: true });
    fs.mkdirSync(resDir, { recursive: true });

    fs.writeFileSync(
      path.join(reqDir, 'new-req.json'),
      JSON.stringify({ requestId: 'new-req', chatJid: 'other@g.us' }),
    );

    startIpcWatcher(deps, ipcBaseDir);

    expect(fs.existsSync(path.join(resDir, 'new-req.json'))).toBe(false);
  });
});

describe('startIpcWatcher — permission request forwarding', () => {
  it('calls onPermissionRequest and renames file to .processing', async () => {
    const onPermissionRequest = vi.fn();
    deps.onPermissionRequest = onPermissionRequest;

    const permDir = path.join(ipcBaseDir, 'other-group', 'permissions', 'requests');
    fs.mkdirSync(permDir, { recursive: true });
    fs.writeFileSync(
      path.join(permDir, 'perm-001.json'),
      JSON.stringify({
        type: 'permission_request',
        requestId: 'perm-001',
        chatJid: 'other@g.us',
        toolName: 'bash',
        toolInput: { command: 'ls' },
      }),
    );

    startIpcWatcher(deps, ipcBaseDir);
    await vi.advanceTimersByTimeAsync(10);

    expect(onPermissionRequest).toHaveBeenCalledWith(
      'other@g.us',
      'other-group',
      'perm-001',
      'bash',
      { command: 'ls' },
    );

    expect(fs.existsSync(path.join(permDir, 'perm-001.json'))).toBe(false);
    expect(fs.existsSync(path.join(permDir, 'perm-001.processing'))).toBe(true);
  });
});
