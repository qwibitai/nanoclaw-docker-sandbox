import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock('./permission-rule-engine/rule-engine.js', () => ({
  checkPermissionRule: vi.fn().mockReturnValue(undefined),
}));

vi.mock('./permission-rule-generator.js', () => ({
  generateRuleProposal: vi.fn().mockResolvedValue(null),
}));

import { checkPermissionRule } from './permission-rule-engine/rule-engine.js';
import {
  createMcpBridge,
  type McpBridgeDeps,
  type BridgeConfig,
} from './mcp-bridge.js';

function makeDeps(overrides?: Partial<McpBridgeDeps>): McpBridgeDeps {
  return {
    sendPermissionRequest: vi.fn().mockResolvedValue(42),
    onPermissionResponse: vi.fn(),
    groupFolder: 'test-group',
    chatJid: 'tg:123',
    ...overrides,
  };
}

const testConfig: BridgeConfig = {
  name: 'vercel',
  url: 'https://mcp.vercel.com',
  headers: { Authorization: 'Bearer test-token' },
};

describe('MCP bridge permission gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('auto-allows tools/list without permission check', async () => {
    const bridge = createMcpBridge(testConfig, makeDeps());
    await bridge.handleJsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    });
    expect(checkPermissionRule).not.toHaveBeenCalled();
  });

  it('auto-allows initialize without permission check', async () => {
    const bridge = createMcpBridge(testConfig, makeDeps());
    await bridge.handleJsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });
    expect(checkPermissionRule).not.toHaveBeenCalled();
  });

  it('checks permission for tools/call', async () => {
    vi.mocked(checkPermissionRule).mockReturnValue('allow');
    const bridge = createMcpBridge(testConfig, makeDeps());
    await bridge.handleJsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'list_teams', arguments: {} },
    });
    expect(checkPermissionRule).toHaveBeenCalledWith(
      'mcp',
      'mcp__vercel__list_teams',
      'test-group',
    );
  });

  it('checks permission for resources/read', async () => {
    vi.mocked(checkPermissionRule).mockReturnValue('allow');
    const bridge = createMcpBridge(testConfig, makeDeps());
    await bridge.handleJsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'resources/read',
      params: { uri: 'file:///config.json' },
    });
    expect(checkPermissionRule).toHaveBeenCalled();
  });

  it('returns JSON-RPC error when permission denied by rule', async () => {
    vi.mocked(checkPermissionRule).mockReturnValue('deny');
    const bridge = createMcpBridge(testConfig, makeDeps());
    const response = await bridge.handleJsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'deploy', arguments: {} },
    });
    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32600, message: expect.stringContaining('denied') },
    });
  });

  it('sends Telegram approval when no rule matches', async () => {
    vi.mocked(checkPermissionRule).mockReturnValue(undefined);
    const deps = makeDeps();
    const bridge = createMcpBridge(testConfig, deps);
    // Simulate approval in background
    vi.mocked(deps.sendPermissionRequest).mockImplementation(async () => {
      setTimeout(() => bridge.resolvePermission('test-request-id', 'once'), 10);
      return 42;
    });
    // We can't predict the requestId, so resolve via a different approach:
    // Override sendPermissionRequest to capture the requestId, then resolve it
    vi.mocked(deps.sendPermissionRequest).mockImplementation(async (req) => {
      setTimeout(() => bridge.resolvePermission(req.requestId, 'once'), 10);
      return 42;
    });
    await bridge.handleJsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'list_teams', arguments: {} },
    });
    expect(deps.sendPermissionRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        egressType: 'mcp',
        subject: 'mcp__vercel__list_teams',
      }),
    );
  });

  it('constructs MCP tool subject as mcp__{server}__{tool}', async () => {
    vi.mocked(checkPermissionRule).mockReturnValue('allow');
    const bridge = createMcpBridge(
      { ...testConfig, name: 'github' },
      makeDeps(),
    );
    await bridge.handleJsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'create_issue', arguments: { title: 'Bug' } },
    });
    expect(checkPermissionRule).toHaveBeenCalledWith(
      'mcp',
      'mcp__github__create_issue',
      'test-group',
    );
  });

  it('returns deny on permission timeout', async () => {
    vi.useFakeTimers();
    vi.mocked(checkPermissionRule).mockReturnValue(undefined);
    const deps = makeDeps();
    vi.mocked(deps.sendPermissionRequest).mockResolvedValue(42);
    const bridge = createMcpBridge(testConfig, deps);

    const resultPromise = bridge.handleJsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'deploy', arguments: {} },
    });

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 1);
    const response = await resultPromise;
    expect(response.error?.message).toContain('denied');
    vi.useRealTimers();
  });

  it('returns deny when sendPermissionRequest throws', async () => {
    vi.mocked(checkPermissionRule).mockReturnValue(undefined);
    const deps = makeDeps();
    vi.mocked(deps.sendPermissionRequest).mockRejectedValue(
      new Error('Telegram API error'),
    );
    const bridge = createMcpBridge(testConfig, deps);
    const response = await bridge.handleJsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'deploy', arguments: {} },
    });
    expect(response.error?.message).toContain('denied');
  });

  it('forwards unknown methods without permission check', async () => {
    const bridge = createMcpBridge(testConfig, makeDeps());
    await bridge.handleJsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'custom/method',
      params: {},
    });
    expect(checkPermissionRule).not.toHaveBeenCalled();
  });
});
