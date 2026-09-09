import { describe, expect, it } from 'vitest';
import {
  conversationToQoderLines,
  forgeNewQoderSessionData,
  type QoderLine,
} from '../parsers/qoder.js';
import type { ConversationMessage } from '../types/index.js';

describe('conversationToQoderLines (cross-source forge input)', () => {
  const messages: ConversationMessage[] = [
    { role: 'system', content: 'system preamble' },
    { role: 'user', content: '帮我看看claude code源码里的snip机制', timestamp: new Date(1788500000000) },
    { role: 'assistant', content: '正在分析…', timestamp: new Date(1788500001000) },
    { role: 'user', content: '   ' },
  ];

  it('maps unified messages to Anthropic-shaped lines, dropping system and empty rows', () => {
    const lines = conversationToQoderLines(messages);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({
      type: 'user',
      timestamp: new Date(1788500000000).toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: '帮我看看claude code源码里的snip机制' }] },
    });
    expect(lines[1].type).toBe('assistant');
    expect(lines[1].message?.role).toBe('assistant');
  });

  it('feeds forgeNewQoderSessionData with per-message fidelity for non-Anthropic sources', () => {
    const { messages: uiMessages, transcriptLines } = forgeNewQoderSessionData(
      conversationToQoderLines(messages),
      '01234567-89ab-4cde-8f01-234567890abc',
      '/home/user/project',
      1788500000000,
    );
    expect(uiMessages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(uiMessages[0].text).toContain('snip机制');
    const body = transcriptLines.map((l) => JSON.parse(l) as Record<string, unknown>).slice(2, -2);
    expect(body.map((l) => l.type)).toEqual(['user', 'assistant']);
  });
});

describe('qoder New-Qoder forge session data', () => {
  const sessionId = '01234567-89ab-4cde-8f01-234567890abc';
  const cwd = '/home/user/project';
  const startedAt = 1788500000000;

  const source: QoderLine[] = [
    { type: 'workspace-directories', sessionId: 'old', directories: [cwd] },
    { type: 'runtime-config', sessionId: 'old' },
    {
      // string-content user (qoderwork layout)
      type: 'user',
      message: { role: 'user', content: 'Fix the login bug' },
    },
    {
      // tool_result-only user lines are dropped
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Reproduce first' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    },
    {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Found it.' }] },
    },
    {
      // sidechain lines are dropped
      type: 'user',
      isSidechain: true,
      message: { role: 'user', content: 'subagent prompt' },
    },
    {
      // system-wrapped user lines are dropped
      type: 'user',
      message: { role: 'user', content: '<system-reminder>hello</system-reminder>' },
    },
    {
      // block-content user (qoder CLI / New Qoder layout)
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'Ship it' }] },
    },
    {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
    },
  ];

  it('mirrors transcript and UI-message projections', () => {
    const { transcriptLines, messages } = forgeNewQoderSessionData(source, sessionId, cwd, startedAt);

    // 2 user turns + 2 text-bearing assistant turns survive the filter
    // (the thinking-only assistant line lands in the transcript but has no
    // text blocks, so it yields no UI message)
    expect(messages).toHaveLength(4);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(messages.map((m) => m.text)).toEqual(['Fix the login bug', 'Found it.', 'Ship it', 'Done.']);

    // transcript = bookkeeping head + chained messages + bookkeeping tail
    const parsed = transcriptLines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed[0].type).toBe('workspace-directories');
    expect(parsed[1].type).toBe('runtime-config');
    expect(parsed[2].type).toBe('user');
    expect(parsed.at(-2)!.type).toBe('last-prompt');
    expect(parsed.at(-1)!.type).toBe('active-leaf');
    const body = parsed.slice(2, -2);
    expect(body.map((l) => l.type)).toEqual(['user', 'assistant', 'assistant', 'user', 'assistant']);
  });

  it('keeps the transcript parentUuid chain strict', () => {
    const { transcriptLines } = forgeNewQoderSessionData(source, sessionId, cwd, startedAt);
    const parsed = transcriptLines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const body = parsed.slice(2, -2);
    expect(body[0].parentUuid).toBeNull();
    for (let i = 1; i < body.length; i++) {
      expect(body[i].parentUuid).toBe(body[i - 1].uuid);
    }
    // active-leaf points at the last message
    expect(parsed.at(-1)!.leafUuid).toBe(body.at(-1)!.uuid);
  });

  it('rewrites every line onto the forged session id and cwd', () => {
    const { transcriptLines } = forgeNewQoderSessionData(source, sessionId, cwd, startedAt);
    for (const line of transcriptLines.map((l) => JSON.parse(l) as Record<string, unknown>)) {
      expect(line.sessionId).toBe(sessionId);
      // cwd lives on the conversation lines (bookkeeping rows omit it)
      if (line.type === 'user' || line.type === 'assistant') {
        expect(line.cwd).toBe(cwd);
      }
    }
    const head = JSON.parse(transcriptLines[0]) as { directories: string[] };
    expect(head.directories).toEqual([cwd]);
  });

  it('links assistant messages to their user turn', () => {
    const { messages } = forgeNewQoderSessionData(source, sessionId, cwd, startedAt);
    const userTurn = messages[0].turnId;
    expect(messages[1].turnId).toBe(userTurn); // same turn
    expect(messages[2].turnId).not.toBe(userTurn); // new turn
    expect(messages[3].turnId).toBe(messages[2].turnId);
  });

  it('keeps thinking blocks in the transcript but only text in UI messages', () => {
    const { transcriptLines, messages } = forgeNewQoderSessionData(source, sessionId, cwd, startedAt);
    const parsed = transcriptLines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const body = parsed.slice(2, -2);
    const first = body[1] as { message: { content: Array<{ type: string }> } };
    expect(first.message.content.map((b) => b.type)).toEqual(['thinking']);
    // assistant messages without text blocks produce no UI message
    expect(messages.some((m) => m.role === 'assistant' && m.text === '')).toBe(false);
  });

  it('records the last user text in last-prompt', () => {
    const { transcriptLines, lastUserText } = forgeNewQoderSessionData(source, sessionId, cwd, startedAt);
    expect(lastUserText).toBe('Ship it');
    const parsed = transcriptLines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed.at(-2)!.lastPrompt).toBe('Ship it');
  });

  it("aggregates an assistant turn into one message per streamed fragments", () => {
    const streamed: QoderLine[] = [
      { type: 'user', message: { role: 'user', content: 'Go' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'part one' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'mid' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'part two' }] } },
    ];
    const { messages, transcriptLines } = forgeNewQoderSessionData(streamed, sessionId, cwd, startedAt);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toEqual({ role: 'assistant', text: 'part one\n\npart two', turnId: messages[0].turnId });
    // transcript keeps every line (agent context needs the full stream)
    const body = transcriptLines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .slice(2, -2);
    expect(body.map((l) => l.type)).toEqual(['user', 'assistant', 'assistant', 'assistant']);
  });

  it('drops system-reminder blocks and harness skill prompts from user lines (qoderwork quirks)', () => {
    const source: QoderLine[] = [
      // qoderwork concatenates the environment reminder with the real prompt
      // in ONE user line's block array — the real prompt must survive
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '<system-reminder> User environment — Tim' },
            { type: 'text', text: '介绍一下nc的workflow' },
          ],
        },
      },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '我先确认。' }] } },
      // harness-injected skill-discovery prompt — never shown as a user turn
      { type: 'user', message: { role: 'user', content: '# Find Skills\nThis is a unified skill discovery…' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '检索中' }] } },
      // tool_result-only user line stays dropped
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    ];
    const { messages } = forgeNewQoderSessionData(source, sessionId, cwd, startedAt);

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('user');
    expect(messages[0].text).toBe('介绍一下nc的workflow');
    expect(messages[1].role).toBe('assistant');
    // both assistant fragments belong to the single real turn
    expect(messages[1].text).toContain('我先确认。');
    expect(messages[1].text).toContain('检索中');
  });
});
