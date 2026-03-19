/**
 * Tests for the unified permission resolver registry.
 * Verifies that handleProxyPermissionResponse routes responses to both
 * proxy resolvers (pendingPermissions) and bridge resolvers (registry).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _initTestDatabase } from './db.js';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

vi.mock('./db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./db.js')>();
  return { ...actual, insertPermissionRule: vi.fn() };
});

import {
  _getRegistrySize,
  handleProxyPermissionResponse,
  registerPermissionResolver,
  resolvePermission,
} from './credential-proxy.js';
import { insertPermissionRule } from './db.js';

beforeEach(() => {
  _initTestDatabase();
  vi.clearAllMocks();
});

describe('unified permission response routing', () => {
  it('routes response to proxy resolver (existing behaviour)', () => {
    // handleProxyPermissionResponse with an unknown ID does not throw
    expect(() => handleProxyPermissionResponse('unknown-id', 'once')).not.toThrow();
    expect(insertPermissionRule).not.toHaveBeenCalled();
  });

  it('routes response to bridge resolver via the registry', async () => {
    const resolved = vi.fn();
    registerPermissionResolver('bridge-req-1', {
      resolve: resolved,
      egressType: 'mcp',
      proposal: null,
      groupFolder: 'test-group',
    });

    handleProxyPermissionResponse('bridge-req-1', 'once');

    expect(resolved).toHaveBeenCalledWith('allow');
    expect(_getRegistrySize()).toBe(0); // cleaned up after resolution
  });

  it('routes deny to bridge resolver', () => {
    const resolved = vi.fn();
    registerPermissionResolver('bridge-req-2', {
      resolve: resolved,
      egressType: 'mcp',
      proposal: null,
      groupFolder: 'test-group',
    });

    handleProxyPermissionResponse('bridge-req-2', 'deny');

    expect(resolved).toHaveBeenCalledWith('deny');
    expect(_getRegistrySize()).toBe(0);
  });

  it('persists "always" rule for bridge permissions with a proposal', () => {
    const resolved = vi.fn();
    registerPermissionResolver('bridge-req-3', {
      resolve: resolved,
      egressType: 'mcp',
      proposal: {
        name: 'Allow Slack search',
        pattern: 'mcp__slack__search',
        scope: 'global' as const,
        description: 'Allow Slack search tool globally',
      },
      groupFolder: 'test-group',
    });

    handleProxyPermissionResponse('bridge-req-3', 'always');

    expect(resolved).toHaveBeenCalledWith('allow');
    expect(insertPermissionRule).toHaveBeenCalledTimes(1);
    const mockedInsert = vi.mocked(insertPermissionRule);
    const rule = mockedInsert.mock.calls[0]?.[0];
    expect(rule).toBeDefined();
    expect(rule?.egress_type).toBe('mcp');
    expect(rule?.pattern).toBe('mcp__slack__search');
    expect(rule?.effect).toBe('allow');
    expect(rule?.scope).toBe('global');
    expect(rule?.group_folder).toBeNull();
    expect(rule?.source).toBe('telegram');
  });

  it('persists "always" rule with group scope', () => {
    const resolved = vi.fn();
    registerPermissionResolver('bridge-req-4', {
      resolve: resolved,
      egressType: 'mcp',
      proposal: {
        name: 'Allow Jira create',
        pattern: 'mcp__jira__create_issue',
        scope: 'group' as const,
        description: 'Allow Jira create in this group',
      },
      groupFolder: 'my-project',
    });

    handleProxyPermissionResponse('bridge-req-4', 'always');

    const rule = vi.mocked(insertPermissionRule).mock.calls[0]?.[0];
    expect(rule).toBeDefined();
    expect(rule?.scope).toBe('group');
    expect(rule?.group_folder).toBe('my-project');
  });

  it('does not persist rule when decision is "once"', () => {
    const resolved = vi.fn();
    registerPermissionResolver('bridge-req-5', {
      resolve: resolved,
      egressType: 'mcp',
      proposal: {
        name: 'Allow something',
        pattern: 'mcp__test__tool',
        scope: 'global' as const,
        description: 'Test',
      },
      groupFolder: 'test-group',
    });

    handleProxyPermissionResponse('bridge-req-5', 'once');

    expect(insertPermissionRule).not.toHaveBeenCalled();
    expect(resolved).toHaveBeenCalledWith('allow');
  });

  it('does not persist rule when proposal is null', () => {
    const resolved = vi.fn();
    registerPermissionResolver('bridge-req-6', {
      resolve: resolved,
      egressType: 'mcp',
      proposal: null,
      groupFolder: 'test-group',
    });

    handleProxyPermissionResponse('bridge-req-6', 'always');

    expect(insertPermissionRule).not.toHaveBeenCalled();
    expect(resolved).toHaveBeenCalledWith('allow');
  });

  it('handles unknown requestId gracefully', () => {
    expect(() =>
      handleProxyPermissionResponse('nonexistent', 'once'),
    ).not.toThrow();
    expect(insertPermissionRule).not.toHaveBeenCalled();
  });
});
