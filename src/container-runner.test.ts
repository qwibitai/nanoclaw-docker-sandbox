import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  TIMEZONE: 'America/Los_Angeles',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(() => ''),
    readdirSync: vi.fn(() => []),
    statSync: vi.fn(() => ({ isDirectory: () => false })),
    copyFileSync: vi.fn(),
    cpSync: vi.fn(),
  },
}));

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', () => ({
  spawn: vi.fn(() => fakeProc),
  execSync: vi.fn((cmd: string) => {
    if (cmd.includes('network inspect nanoclaw-proxy')) return '172.20.0.1\n';
    return '';
  }),
  exec: vi.fn(
    (
      cmd: string,
      optsOrCb?: unknown,
      cb?: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      // exec(cmd, callback) or exec(cmd, opts, callback)
      const callback =
        typeof optsOrCb === 'function'
          ? (optsOrCb as (
              err: Error | null,
              stdout: string,
              stderr: string,
            ) => void)
          : cb;
      if (callback) {
        // Return a fake IP for docker inspect calls
        const stdout = cmd.includes('inspect') ? '172.19.0.2\n' : '';
        callback(null, stdout, '');
      }
      return new EventEmitter();
    },
  ),
}));

// Mock the group registry so we can assert registrations
vi.mock('./container-group-registry.js', () => ({
  registerContainerGroup: vi.fn(),
  deregisterContainerGroup: vi.fn(),
  resolveContainerGroup: vi.fn().mockReturnValue(null),
  _clearRegistry: vi.fn(),
}));

import { spawn } from 'node:child_process';
import {
  deregisterContainerGroup,
  registerContainerGroup,
} from './container-group-registry.js';
import { type ContainerOutput, runContainerAgent } from './container-runner.js';
import type { RegisteredGroup } from './types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testGroupWithPermissionApproval: RegisteredGroup = {
  ...testGroup,
  containerConfig: { permissionApproval: true },
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner spawn args', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Run the container to completion and return the spawn args. */
  async function spawnArgsFor(group: RegisteredGroup): Promise<string[]> {
    vi.mocked(spawn).mockClear();
    const resultPromise = runContainerAgent(group, testInput, () => {});
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'ok',
      newSessionId: 's1',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
    return [...(vi.mocked(spawn).mock.calls[0]?.[1] ?? [])];
  }

  /** Pull all `-e KEY=VALUE` entries from spawn args. */
  function envArgs(args: string[]): Record<string, string> {
    const result: Record<string, string> = {};
    for (let i = 0; i < args.length - 1; i++) {
      const nextArg = args[i + 1];
      if (args[i] === '-e' && nextArg !== undefined) {
        const eq = nextArg.indexOf('=');
        if (eq !== -1) {
          result[nextArg.slice(0, eq)] = nextArg.slice(eq + 1);
        }
      }
    }
    return result;
  }

  it('includes host.docker.internal in NO_PROXY when permissionApproval is true', async () => {
    const args = await spawnArgsFor(testGroupWithPermissionApproval);
    const env = envArgs(args);
    expect(env.NO_PROXY).toContain('host.docker.internal');
    expect(env.no_proxy).toContain('host.docker.internal');
  });

  it('sets HTTP_PROXY and HTTPS_PROXY to credential proxy URL when permissionApproval is true', async () => {
    const args = await spawnArgsFor(testGroupWithPermissionApproval);
    const env = envArgs(args);
    expect(env.HTTP_PROXY).toMatch(/^http:\/\/host\.docker\.internal:\d+$/);
    expect(env.HTTPS_PROXY).toMatch(/^http:\/\/host\.docker\.internal:\d+$/);
    expect(env.http_proxy).toMatch(/^http:\/\/host\.docker\.internal:\d+$/);
    expect(env.https_proxy).toMatch(/^http:\/\/host\.docker\.internal:\d+$/);
  });

  it('attaches nanoclaw-proxy network when permissionApproval is true', async () => {
    const args = await spawnArgsFor(testGroupWithPermissionApproval);
    const networkIdx = args.indexOf('--network');
    expect(networkIdx).not.toBe(-1);
    expect(args[networkIdx + 1]).toBe('nanoclaw-proxy');
  });

  it('adds host.docker.internal host entry when permissionApproval is true', async () => {
    const args = await spawnArgsFor(testGroupWithPermissionApproval);
    const addHostIdx = args.indexOf('--add-host');
    expect(addHostIdx).not.toBe(-1);
    expect(args[addHostIdx + 1]).toBe('host.docker.internal:host-gateway');
  });

  it('drops all capabilities and disables privilege escalation when permissionApproval is true', async () => {
    const args = await spawnArgsFor(testGroupWithPermissionApproval);
    const capDropIdx = args.indexOf('--cap-drop');
    expect(capDropIdx).not.toBe(-1);
    expect(args[capDropIdx + 1]).toBe('ALL');
    expect(args).toContain('no-new-privileges');
  });

  it('does not drop capabilities when permissionApproval is false', async () => {
    const args = await spawnArgsFor(testGroup);
    expect(args).not.toContain('--cap-drop');
    expect(args).not.toContain('no-new-privileges');
  });

  it('does not inject credential proxy vars when permissionApproval is false', async () => {
    const args = await spawnArgsFor(testGroup);
    const env = envArgs(args);
    // When permissionApproval is false, the credential proxy URL (host.docker.internal)
    // must NOT be injected. A system-level proxy may still appear from process.env.
    expect(env.HTTP_PROXY ?? '').not.toMatch(/host\.docker\.internal/);
    expect(env.HTTPS_PROXY ?? '').not.toMatch(/host\.docker\.internal/);
  });

  it('registers container IP in group registry when permissionApproval is true', async () => {
    vi.mocked(registerContainerGroup).mockClear();
    await spawnArgsFor(testGroupWithPermissionApproval);
    // Allow async IP lookup to complete
    await vi.waitFor(() =>
      expect(registerContainerGroup).toHaveBeenCalledWith(
        '172.19.0.2',
        expect.objectContaining({ groupFolder: testGroup.folder }),
      ),
    );
  });

  it('deregisters container IP when container exits', async () => {
    vi.mocked(deregisterContainerGroup).mockClear();
    await spawnArgsFor(testGroupWithPermissionApproval);
    await vi.waitFor(() => expect(registerContainerGroup).toHaveBeenCalled());

    fakeProc.emit('close', 0);

    await vi.waitFor(() =>
      expect(deregisterContainerGroup).toHaveBeenCalledWith('172.19.0.2'),
    );
  });

  it('does not register IP when permissionApproval is false', async () => {
    vi.mocked(registerContainerGroup).mockClear();
    await spawnArgsFor(testGroup);
    await vi.advanceTimersByTimeAsync(500);
    expect(registerContainerGroup).not.toHaveBeenCalled();
  });
});

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });
});
