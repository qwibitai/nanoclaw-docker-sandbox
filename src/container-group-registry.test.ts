import { beforeEach, describe, expect, it } from 'vitest';
import {
  _clearRegistry,
  deregisterContainerGroup,
  registerContainerGroup,
  resolveContainerGroup,
} from './container-group-registry.js';

beforeEach(() => {
  _clearRegistry();
});

describe('resolveContainerGroup', () => {
  it('returns null for unknown IP', () => {
    expect(resolveContainerGroup('172.19.0.2')).toBeNull();
  });

  it('returns the registered entry for a known IP', () => {
    registerContainerGroup('172.19.0.2', {
      groupFolder: 'my-group',
      chatJid: 'tg:123',
    });
    expect(resolveContainerGroup('172.19.0.2')).toEqual({
      groupFolder: 'my-group',
      chatJid: 'tg:123',
    });
  });

  it('strips ::ffff: IPv4-mapped IPv6 prefix before lookup', () => {
    registerContainerGroup('172.19.0.2', {
      groupFolder: 'my-group',
      chatJid: 'tg:123',
    });
    expect(resolveContainerGroup('::ffff:172.19.0.2')).toEqual({
      groupFolder: 'my-group',
      chatJid: 'tg:123',
    });
  });

  it('returns null after deregistration', () => {
    registerContainerGroup('172.19.0.2', {
      groupFolder: 'my-group',
      chatJid: 'tg:123',
    });
    deregisterContainerGroup('172.19.0.2');
    expect(resolveContainerGroup('172.19.0.2')).toBeNull();
  });

  it('deregister is a no-op for unknown IP', () => {
    expect(() => deregisterContainerGroup('10.0.0.1')).not.toThrow();
  });

  it('multiple groups can be registered simultaneously', () => {
    registerContainerGroup('172.19.0.2', {
      groupFolder: 'group-a',
      chatJid: 'tg:1',
    });
    registerContainerGroup('172.19.0.3', {
      groupFolder: 'group-b',
      chatJid: 'tg:2',
    });

    expect(resolveContainerGroup('172.19.0.2')).toEqual({
      groupFolder: 'group-a',
      chatJid: 'tg:1',
    });
    expect(resolveContainerGroup('172.19.0.3')).toEqual({
      groupFolder: 'group-b',
      chatJid: 'tg:2',
    });
  });
});
