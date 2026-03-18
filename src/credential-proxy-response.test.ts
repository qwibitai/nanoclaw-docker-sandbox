/**
 * Unit tests for handleProxyPermissionResponse and resolvePermission.
 * Tests observable behavior that doesn't require a live proxy server.
 * For the 'always persists rule' path, see test/proxy-permission.integration.test.ts.
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
  handleProxyPermissionResponse,
  resolvePermission,
} from './credential-proxy.js';
import { insertPermissionRule } from './db.js';

beforeEach(() => {
  _initTestDatabase();
  vi.clearAllMocks();
});

describe('handleProxyPermissionResponse', () => {
  it('deny: does not call insertPermissionRule', () => {
    handleProxyPermissionResponse('any-id', 'deny');
    expect(insertPermissionRule).not.toHaveBeenCalled();
  });

  it('once: does not call insertPermissionRule', () => {
    handleProxyPermissionResponse('any-id', 'once');
    expect(insertPermissionRule).not.toHaveBeenCalled();
  });

  it('always with no pending entry: does not call insertPermissionRule', () => {
    // Guard-rail: if the request timed out before the tap, nothing is persisted
    handleProxyPermissionResponse('no-such-id', 'always');
    expect(insertPermissionRule).not.toHaveBeenCalled();
  });
});

describe('resolvePermission', () => {
  it('unknown requestId does not throw', () => {
    expect(() => resolvePermission('no-such-id', 'allow')).not.toThrow();
    expect(() => resolvePermission('no-such-id', 'deny')).not.toThrow();
  });
});
