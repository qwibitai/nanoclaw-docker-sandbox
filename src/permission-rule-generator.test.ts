import { describe, it, expect, vi, beforeEach } from 'vitest';

// Must mock before importing the module under test
const mockCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  function MockAnthropic() {
    return { messages: { create: mockCreate } };
  }
  return { default: MockAnthropic };
});

import Anthropic from '@anthropic-ai/sdk';
import {
  generateRuleProposal,
  buildPrompt,
  htmlEscape,
  validateProposal,
} from './permission-rule-generator.js';

function getMockCreate(): ReturnType<typeof vi.fn> {
  return mockCreate;
}

function makeValidResponse(overrides: Record<string, unknown> = {}) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          name: 'Allow OpenAI API',
          pattern: 'https://api.openai.com/*',
          scope: 'global',
          description: 'Allow requests to the OpenAI API.',
          ...overrides,
        }),
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('htmlEscape', () => {
  it('escapes all five special HTML characters', () => {
    expect(htmlEscape('<script>&"\'</script>')).toBe(
      '&lt;script&gt;&amp;&quot;&#39;&lt;/script&gt;',
    );
  });

  it('leaves normal URLs unchanged', () => {
    expect(htmlEscape('https://api.openai.com/v1/chat')).toBe(
      'https://api.openai.com/v1/chat',
    );
  });
});

describe('buildPrompt', () => {
  it('contains <request> delimiters wrapping the HTML-escaped subject', () => {
    const subject = 'https://example.com/<path>';
    const prompt = buildPrompt('http', subject);

    expect(prompt).toContain('<request>');
    expect(prompt).toContain('</request>');
    expect(prompt).toContain('https://example.com/&lt;path&gt;');
    const requestBlock = prompt.match(/<request>([\s\S]*?)<\/request>/)?.[1];
    expect(requestBlock).toBeDefined();
    expect(requestBlock).not.toContain('<path>');
  });

  it('includes the egress_type in the prompt', () => {
    const prompt = buildPrompt('connect', 'api.github.com:443');
    expect(prompt).toContain('connect');
  });
});

describe('validateProposal', () => {
  it('accepts a valid http proposal', () => {
    const result = validateProposal(
      {
        name: 'Allow OpenAI API',
        pattern: 'https://api.openai.com/*',
        scope: 'global',
        description: 'Allow requests to the OpenAI API.',
      },
      'http',
    );
    expect(result).not.toBeNull();
    expect(result?.name).toBe('Allow OpenAI API');
  });

  it('rejects name > 40 chars', () => {
    expect(
      validateProposal(
        {
          name: 'A'.repeat(41),
          pattern: 'https://api.openai.com/*',
          scope: 'global',
          description: 'desc',
        },
        'http',
      ),
    ).toBeNull();
  });

  it('rejects bare * pattern', () => {
    expect(
      validateProposal(
        {
          name: 'Allow all',
          pattern: '*',
          scope: 'global',
          description: 'desc',
        },
        'http',
      ),
    ).toBeNull();
  });

  it('rejects ** pattern', () => {
    expect(
      validateProposal(
        {
          name: 'Allow all',
          pattern: '**',
          scope: 'global',
          description: 'desc',
        },
        'http',
      ),
    ).toBeNull();
  });

  it('rejects *:* pattern', () => {
    expect(
      validateProposal(
        {
          name: 'Allow all',
          pattern: '*:*',
          scope: 'global',
          description: 'desc',
        },
        'connect',
      ),
    ).toBeNull();
  });

  it('rejects *:443 pattern', () => {
    expect(
      validateProposal(
        {
          name: 'Allow all',
          pattern: '*:443',
          scope: 'global',
          description: 'desc',
        },
        'connect',
      ),
    ).toBeNull();
  });

  it('rejects invalid scope', () => {
    expect(
      validateProposal(
        {
          name: 'Allow X',
          pattern: 'https://example.com/*',
          scope: 'team',
          description: 'desc',
        },
        'http',
      ),
    ).toBeNull();
  });

  it('rejects connect pattern without colon', () => {
    expect(
      validateProposal(
        {
          name: 'Allow GitHub',
          pattern: '*.github.com',
          scope: 'global',
          description: 'desc',
        },
        'connect',
      ),
    ).toBeNull();
  });

  it('accepts connect pattern with colon', () => {
    expect(
      validateProposal(
        {
          name: 'Allow GitHub',
          pattern: '*.github.com:443',
          scope: 'global',
          description: 'desc',
        },
        'connect',
      ),
    ).not.toBeNull();
  });

  it('rejects mcp pattern not starting with mcp__', () => {
    expect(
      validateProposal(
        {
          name: 'Allow tool',
          pattern: 'nanoclaw__send_message',
          scope: 'group',
          description: 'desc',
        },
        'mcp',
      ),
    ).toBeNull();
  });

  it('accepts mcp pattern starting with mcp__', () => {
    expect(
      validateProposal(
        {
          name: 'Allow send',
          pattern: 'mcp__nanoclaw__send_message',
          scope: 'group',
          description: 'desc',
        },
        'mcp',
      ),
    ).not.toBeNull();
  });

  it('rejects non-object input', () => {
    expect(validateProposal('string', 'http')).toBeNull();
    expect(validateProposal(null, 'http')).toBeNull();
    expect(validateProposal(42, 'http')).toBeNull();
  });

  it('rejects proposal with missing fields', () => {
    expect(
      validateProposal(
        { name: 'Allow X', pattern: 'https://example.com/*' },
        'http',
      ),
    ).toBeNull();
  });
});

describe('generateRuleProposal', () => {
  it('returns RuleProposal on valid Haiku response', async () => {
    const mockCreate = getMockCreate();
    mockCreate.mockResolvedValueOnce(makeValidResponse());

    const result = await generateRuleProposal(
      'http',
      'https://api.openai.com/v1/chat',
    );

    expect(result).not.toBeNull();
    expect(result?.name).toBe('Allow OpenAI API');
    expect(result?.pattern).toBe('https://api.openai.com/*');
    expect(result?.scope).toBe('global');
  });

  it('passes HTML-escaped subject inside <request> delimiters to Haiku', async () => {
    const mockCreate = getMockCreate();
    mockCreate.mockResolvedValueOnce(makeValidResponse());

    await generateRuleProposal('http', 'https://evil.com/<injected>');

    const callArgs = mockCreate.mock.calls[0]?.[0];
    const promptContent = callArgs.messages[0].content as string;

    expect(promptContent).toContain('<request>');
    expect(promptContent).toContain('https://evil.com/&lt;injected&gt;');
    expect(promptContent).not.toContain('<injected>');
  });

  it('returns null when Haiku times out', async () => {
    const mockCreate = getMockCreate();
    mockCreate.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(resolve, 60_000)),
    );

    vi.useFakeTimers();
    const promise = generateRuleProposal('http', 'https://example.com/');
    vi.advanceTimersByTime(10_001);
    const result = await promise;
    vi.useRealTimers();

    expect(result).toBeNull();
  });

  it('returns null on invalid JSON response', async () => {
    const mockCreate = getMockCreate();
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'not valid json at all' }],
    });

    expect(
      await generateRuleProposal('http', 'https://example.com/'),
    ).toBeNull();
  });

  it('returns null when Haiku throws an error', async () => {
    const mockCreate = getMockCreate();
    mockCreate.mockRejectedValueOnce(new Error('API error'));

    expect(
      await generateRuleProposal('http', 'https://example.com/'),
    ).toBeNull();
  });

  it('returns null when name exceeds 40 chars in response', async () => {
    const mockCreate = getMockCreate();
    mockCreate.mockResolvedValueOnce(
      makeValidResponse({ name: 'A'.repeat(41) }),
    );

    expect(
      await generateRuleProposal('http', 'https://example.com/'),
    ).toBeNull();
  });

  it('returns null for * pattern in response', async () => {
    const mockCreate = getMockCreate();
    mockCreate.mockResolvedValueOnce(makeValidResponse({ pattern: '*' }));

    expect(
      await generateRuleProposal('http', 'https://example.com/'),
    ).toBeNull();
  });

  it('returns null for bad scope in response', async () => {
    const mockCreate = getMockCreate();
    mockCreate.mockResolvedValueOnce(makeValidResponse({ scope: 'everyone' }));

    expect(
      await generateRuleProposal('http', 'https://example.com/'),
    ).toBeNull();
  });

  it('returns null for connect pattern without : in response', async () => {
    const mockCreate = getMockCreate();
    mockCreate.mockResolvedValueOnce(
      makeValidResponse({ pattern: '*.github.com' }),
    );

    expect(
      await generateRuleProposal('connect', 'api.github.com:443'),
    ).toBeNull();
  });

  it('returns null for mcp pattern not starting with mcp__', async () => {
    const mockCreate = getMockCreate();
    mockCreate.mockResolvedValueOnce(
      makeValidResponse({ pattern: 'nanoclaw__send_message' }),
    );

    expect(
      await generateRuleProposal('mcp', 'mcp__nanoclaw__send_message'),
    ).toBeNull();
  });
});
