import * as fc from 'fast-check';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  getPermissionRules,
  insertPermissionRule,
} from '../db.js';
import { checkPermissionRule } from './rule-engine.js';

function makeRule(
  overrides: Partial<Parameters<typeof insertPermissionRule>[0]> &
    Pick<
      Parameters<typeof insertPermissionRule>[0],
      'id' | 'egress_type' | 'pattern' | 'effect' | 'scope'
    >,
): Parameters<typeof insertPermissionRule>[0] {
  return {
    group_folder: null,
    description: 'test rule',
    source: 'user',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  _initTestDatabase();
});

describe('checkPermissionRule', () => {
  it('returns allow when an http allow rule glob-matches the URL', () => {
    insertPermissionRule(
      makeRule({
        id: 'r1',
        egress_type: 'http',
        pattern: 'https://api.openai.com/*',
        effect: 'allow',
        scope: 'global',
      }),
    );

    const result = checkPermissionRule(
      'http',
      'https://api.openai.com/v1/chat/completions',
      'my_group',
    );

    expect(result).toBe('allow');
  });

  it('returns undefined when no rule matches', () => {
    const result = checkPermissionRule(
      'http',
      'https://totally-unknown.example.com/foo',
      'my_group',
    );
    expect(result).toBeUndefined();
  });

  it('global deny beats global allow (tier 2 before tier 4)', () => {
    insertPermissionRule(
      makeRule({
        id: 'allow-1',
        egress_type: 'connect',
        pattern: '*.github.com:443',
        effect: 'allow',
        scope: 'global',
      }),
    );
    insertPermissionRule(
      makeRule({
        id: 'deny-1',
        egress_type: 'connect',
        pattern: '*.github.com:443',
        effect: 'deny',
        scope: 'global',
      }),
    );

    const result = checkPermissionRule(
      'connect',
      'api.github.com:443',
      'my_group',
    );

    expect(result).toBe('deny');
  });

  it('per-group allow overrides global deny (tier 3 before tier 2)', () => {
    // Global deny for all github
    insertPermissionRule(
      makeRule({
        id: 'global-deny',
        egress_type: 'connect',
        pattern: '*.github.com:443',
        effect: 'deny',
        scope: 'global',
      }),
    );
    // Per-group allow for specific group
    insertPermissionRule(
      makeRule({
        id: 'group-allow',
        egress_type: 'connect',
        pattern: '*.github.com:443',
        effect: 'allow',
        scope: 'group',
        group_folder: 'dev_group',
      }),
    );

    // dev_group gets the per-group allow (tier 3 wins over tier 2)
    const devResult = checkPermissionRule(
      'connect',
      'api.github.com:443',
      'dev_group',
    );
    expect(devResult).toBe('allow');

    // other_group hits the global deny (no per-group rule for it)
    const otherResult = checkPermissionRule(
      'connect',
      'api.github.com:443',
      'other_group',
    );
    expect(otherResult).toBe('deny');
  });

  it('per-group rule does not fire for a different group', () => {
    insertPermissionRule(
      makeRule({
        id: 'group-rule',
        egress_type: 'mcp',
        pattern: 'mcp__nanoclaw__send_message',
        effect: 'allow',
        scope: 'group',
        group_folder: 'alpha_group',
      }),
    );

    const result = checkPermissionRule(
      'mcp',
      'mcp__nanoclaw__send_message',
      'beta_group',
    );

    expect(result).toBeUndefined();
  });

  it('increments match_count on a rule hit', () => {
    insertPermissionRule(
      makeRule({
        id: 'count-rule',
        egress_type: 'http',
        pattern: 'https://example.com/*',
        effect: 'allow',
        scope: 'global',
      }),
    );

    checkPermissionRule('http', 'https://example.com/path', 'some_group');
    checkPermissionRule('http', 'https://example.com/other', 'some_group');

    const rules = getPermissionRules({ egress_type: 'http' });
    const rule = rules.find((r) => r.id === 'count-rule');
    expect(rule?.match_count).toBe(2);
  });

  it('duplicate insert increments match_count, does not create new row', () => {
    const base = makeRule({
      id: 'dup-1',
      egress_type: 'http',
      pattern: 'https://example.com/*',
      effect: 'allow',
      scope: 'global',
    });

    insertPermissionRule(base);
    // Insert exact duplicate (same egress_type, pattern, scope, group_folder, effect)
    insertPermissionRule({ ...base, id: 'dup-2' });

    const rules = getPermissionRules({ egress_type: 'http' });
    // Only one row should exist
    expect(rules).toHaveLength(1);
    // match_count incremented by duplicate insert
    expect(rules[0]?.match_count).toBe(1);
  });
});

describe('checkPermissionRule property tests', () => {
  it('global deny always beats global allow regardless of insertion order', () => {
    fc.assert(
      fc.property(fc.boolean(), (denyFirst) => {
        _initTestDatabase();

        const denyRule = makeRule({
          id: 'prop-deny',
          egress_type: 'http',
          pattern: 'https://api.test.com/*',
          effect: 'deny',
          scope: 'global',
        });
        const allowRule = makeRule({
          id: 'prop-allow',
          egress_type: 'http',
          pattern: 'https://api.test.com/*',
          effect: 'allow',
          scope: 'global',
        });

        if (denyFirst) {
          insertPermissionRule(denyRule);
          insertPermissionRule(allowRule);
        } else {
          insertPermissionRule(allowRule);
          insertPermissionRule(denyRule);
        }

        const result = checkPermissionRule(
          'http',
          'https://api.test.com/v1',
          'test_group',
        );
        return result === 'deny';
      }),
    );
  });
});
