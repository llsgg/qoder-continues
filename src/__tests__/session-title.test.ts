import { describe, expect, it } from 'vitest';
import { continuedSessionTitle, firstUserPrompt, sourceSessionTitle } from '../utils/session-title.js';
import type { ConversationMessage, UnifiedSession } from '../types/index.js';

function makeSession(overrides: Partial<UnifiedSession> = {}): UnifiedSession {
  return {
    id: 'test-session',
    source: 'qoder',
    cwd: '/home/user/project',
    lines: 5,
    bytes: 500,
    createdAt: new Date(),
    updatedAt: new Date(),
    originalPath: '/tmp/test.jsonl',
    ...overrides,
  };
}

describe('firstUserPrompt', () => {
  const messages: ConversationMessage[] = [
    { role: 'system', content: 'system preamble' },
    { role: 'user', content: '帮我看看claude code源码里的snip机制' },
    { role: 'assistant', content: '正在分析…' },
    { role: 'user', content: '   ' },
  ];

  it('picks the first real user message and skips injected content', () => {
    expect(firstUserPrompt(messages)).toBe('帮我看看claude code源码里的snip机制');
    expect(firstUserPrompt([{ role: 'user', content: '<environment_context> injected' }])).toBeNull();
    expect(firstUserPrompt([])).toBeNull();
  });
});

describe('sourceSessionTitle', () => {
  it('prefers the native registry title over the summary', () => {
    expect(sourceSessionTitle(makeSession({ title: '介绍 nc workflow', summary: '介绍一下nc的workflow' }))).toBe(
      '介绍 nc workflow',
    );
  });

  it('falls back to the summary, then the first user prompt', () => {
    expect(sourceSessionTitle(makeSession({ summary: '介绍一下nc的workflow' }))).toBe('介绍一下nc的workflow');
    expect(sourceSessionTitle(makeSession(), [{ role: 'user', content: '第一条提问' }])).toBe('第一条提问');
    expect(sourceSessionTitle(makeSession())).toBe('session');
  });
});

describe('continuedSessionTitle', () => {
  it('prefixes the source title with 「续」', () => {
    const session = makeSession({ title: '介绍 nc workflow 和可信交付', source: 'qoderwork' });
    expect(continuedSessionTitle(session)).toBe('续 介绍 nc workflow 和可信交付');
  });

  it('caps long source titles at 40 characters', () => {
    const long = '很长的会话标题'.repeat(10);
    const title = continuedSessionTitle(makeSession({ title: long }));
    expect(title).toBe(`续 ${long.slice(0, 40)}`);
    expect(title.length).toBe(42);
  });

  it('honors a freshly-read override title above the parsed fields', () => {
    const session = makeSession({ title: '旧标题', summary: '旧摘要' });
    expect(continuedSessionTitle(session, [], 'forge 时的最新标题')).toBe('续 forge 时的最新标题');
  });

  it('resolves through summary and first user prompt without a native title', () => {
    expect(continuedSessionTitle(makeSession({ summary: '季度总结' }))).toBe('续 季度总结');
    expect(continuedSessionTitle(makeSession({ source: 'codex' }), [{ role: 'user', content: '新的提问' }])).toBe(
      '续 新的提问',
    );
  });
});
