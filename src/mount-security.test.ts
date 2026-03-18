import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  generateAllowlistTemplate,
  loadMountAllowlist,
  validateAdditionalMounts,
  validateMount,
} from './mount-security.js';

const tmpDir = path.join(os.tmpdir(), `mount-sec-test-${process.pid}`);
const allowlistPath = path.join(tmpDir, 'mount-allowlist.json');

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeAllowlist(content: object): void {
  fs.writeFileSync(allowlistPath, JSON.stringify(content));
}

describe('loadMountAllowlist', () => {
  it('returns null when file does not exist', () => {
    expect(loadMountAllowlist(allowlistPath)).toBeNull();
  });

  it('returns null when file has invalid JSON', () => {
    fs.writeFileSync(allowlistPath, 'not json');
    expect(loadMountAllowlist(allowlistPath)).toBeNull();
  });

  it('returns null when allowedRoots is not an array', () => {
    writeAllowlist({ allowedRoots: 'bad', blockedPatterns: [], nonMainReadOnly: true });
    expect(loadMountAllowlist(allowlistPath)).toBeNull();
  });

  it('returns null when blockedPatterns is missing', () => {
    writeAllowlist({ allowedRoots: [], nonMainReadOnly: true });
    expect(loadMountAllowlist(allowlistPath)).toBeNull();
  });

  it('returns null when nonMainReadOnly is not a boolean', () => {
    writeAllowlist({ allowedRoots: [], blockedPatterns: [], nonMainReadOnly: 'yes' });
    expect(loadMountAllowlist(allowlistPath)).toBeNull();
  });

  it('loads valid allowlist and merges default blocked patterns', () => {
    writeAllowlist({
      allowedRoots: [{ path: tmpDir, allowReadWrite: false }],
      blockedPatterns: ['custom-secret'],
      nonMainReadOnly: false,
    });
    const result = loadMountAllowlist(allowlistPath);
    expect(result).not.toBeNull();
    expect(result?.blockedPatterns).toContain('.ssh');
    expect(result?.blockedPatterns).toContain('custom-secret');
  });

  it('reads fresh on each call (no stale cache across tests)', () => {
    // Write one allowlist, read it, then overwrite, read again — should see updated value
    writeAllowlist({ allowedRoots: [], blockedPatterns: [], nonMainReadOnly: true });
    const first = loadMountAllowlist(allowlistPath);
    expect(first?.nonMainReadOnly).toBe(true);

    writeAllowlist({ allowedRoots: [], blockedPatterns: [], nonMainReadOnly: false });
    const second = loadMountAllowlist(allowlistPath);
    expect(second?.nonMainReadOnly).toBe(false);
  });
});

describe('validateMount', () => {
  it('returns not-allowed when no allowlist configured', () => {
    const result = validateMount({ hostPath: tmpDir }, true, allowlistPath);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('No mount allowlist');
  });

  it('rejects path traversal in containerPath', () => {
    writeAllowlist({ allowedRoots: [], blockedPatterns: [], nonMainReadOnly: true });
    const result = validateMount({ hostPath: tmpDir, containerPath: '../escape' }, true, allowlistPath);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Invalid container path');
  });

  it('rejects absolute containerPath', () => {
    writeAllowlist({ allowedRoots: [], blockedPatterns: [], nonMainReadOnly: true });
    const result = validateMount({ hostPath: tmpDir, containerPath: '/absolute' }, true, allowlistPath);
    expect(result.allowed).toBe(false);
  });

  it('rejects empty containerPath', () => {
    writeAllowlist({ allowedRoots: [], blockedPatterns: [], nonMainReadOnly: true });
    const result = validateMount({ hostPath: tmpDir, containerPath: '   ' }, true, allowlistPath);
    expect(result.allowed).toBe(false);
  });

  it('rejects non-existent host path', () => {
    writeAllowlist({
      allowedRoots: [{ path: tmpDir, allowReadWrite: false }],
      blockedPatterns: [],
      nonMainReadOnly: true,
    });
    const result = validateMount({ hostPath: path.join(tmpDir, 'does-not-exist') }, true, allowlistPath);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('does not exist');
  });

  it('rejects path matching a blocked pattern (.ssh)', () => {
    const sshDir = path.join(tmpDir, '.ssh');
    fs.mkdirSync(sshDir);
    writeAllowlist({
      allowedRoots: [{ path: tmpDir, allowReadWrite: false }],
      blockedPatterns: [],
      nonMainReadOnly: true,
    });
    const result = validateMount({ hostPath: sshDir }, true, allowlistPath);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('.ssh');
  });

  it('rejects path not under any allowed root', () => {
    const outsideDir = path.join(os.tmpdir(), `outside-${process.pid}`);
    fs.mkdirSync(outsideDir, { recursive: true });
    writeAllowlist({
      allowedRoots: [{ path: tmpDir, allowReadWrite: false }],
      blockedPatterns: [],
      nonMainReadOnly: true,
    });
    try {
      const result = validateMount({ hostPath: outsideDir }, true, allowlistPath);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not under any allowed root');
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('allows path under allowed root as readonly when not requesting rw', () => {
    const sub = path.join(tmpDir, 'data');
    fs.mkdirSync(sub);
    writeAllowlist({
      allowedRoots: [{ path: tmpDir, allowReadWrite: true }],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });
    const result = validateMount({ hostPath: sub }, true, allowlistPath);
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(true);
  });

  it('allows read-write when root permits, mount requests it, isMain=true, nonMainReadOnly=false', () => {
    const sub = path.join(tmpDir, 'rw');
    fs.mkdirSync(sub);
    writeAllowlist({
      allowedRoots: [{ path: tmpDir, allowReadWrite: true }],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });
    const result = validateMount({ hostPath: sub, readonly: false }, true, allowlistPath);
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(false);
  });

  it('forces readonly for non-main group when nonMainReadOnly is true', () => {
    const sub = path.join(tmpDir, 'rw2');
    fs.mkdirSync(sub);
    writeAllowlist({
      allowedRoots: [{ path: tmpDir, allowReadWrite: true }],
      blockedPatterns: [],
      nonMainReadOnly: true,
    });
    const result = validateMount({ hostPath: sub, readonly: false }, false, allowlistPath);
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(true);
  });

  it('forces readonly when root does not allowReadWrite', () => {
    const sub = path.join(tmpDir, 'ro');
    fs.mkdirSync(sub);
    writeAllowlist({
      allowedRoots: [{ path: tmpDir, allowReadWrite: false }],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });
    const result = validateMount({ hostPath: sub, readonly: false }, true, allowlistPath);
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(true);
  });

  it('uses basename of hostPath as containerPath when containerPath is omitted', () => {
    const sub = path.join(tmpDir, 'mydata');
    fs.mkdirSync(sub);
    writeAllowlist({
      allowedRoots: [{ path: tmpDir, allowReadWrite: false }],
      blockedPatterns: [],
      nonMainReadOnly: true,
    });
    const result = validateMount({ hostPath: sub }, true, allowlistPath);
    expect(result.allowed).toBe(true);
    expect(result.resolvedContainerPath).toBe('mydata');
  });

  it('includes description in reason when allowedRoot has one', () => {
    const sub = path.join(tmpDir, 'described');
    fs.mkdirSync(sub);
    writeAllowlist({
      allowedRoots: [{ path: tmpDir, allowReadWrite: false, description: 'My projects' }],
      blockedPatterns: [],
      nonMainReadOnly: true,
    });
    const result = validateMount({ hostPath: sub }, true, allowlistPath);
    expect(result.allowed).toBe(true);
    expect(result.reason).toContain('My projects');
  });
});

describe('validateAdditionalMounts', () => {
  it('returns only validated mounts and skips rejected ones', () => {
    const goodDir = path.join(tmpDir, 'good');
    fs.mkdirSync(goodDir);
    writeAllowlist({
      allowedRoots: [{ path: tmpDir, allowReadWrite: false }],
      blockedPatterns: [],
      nonMainReadOnly: true,
    });
    const result = validateAdditionalMounts(
      [
        { hostPath: goodDir },
        { hostPath: path.join(tmpDir, 'nonexistent') },
      ],
      'test-group',
      true,
      allowlistPath,
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.containerPath).toBe('/workspace/extra/good');
    expect(result[0]?.readonly).toBe(true);
  });

  it('returns empty array when no mounts are provided', () => {
    writeAllowlist({ allowedRoots: [], blockedPatterns: [], nonMainReadOnly: true });
    expect(validateAdditionalMounts([], 'test-group', true, allowlistPath)).toHaveLength(0);
  });
});

describe('generateAllowlistTemplate', () => {
  it('returns valid JSON with required fields', () => {
    const template = generateAllowlistTemplate();
    const parsed = JSON.parse(template);
    expect(Array.isArray(parsed.allowedRoots)).toBe(true);
    expect(Array.isArray(parsed.blockedPatterns)).toBe(true);
    expect(typeof parsed.nonMainReadOnly).toBe('boolean');
  });

  it('includes at least one example allowedRoot', () => {
    const parsed = JSON.parse(generateAllowlistTemplate());
    expect(parsed.allowedRoots.length).toBeGreaterThan(0);
  });
});
