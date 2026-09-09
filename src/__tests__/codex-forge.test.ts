import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const tempDirs: string[] = [];

function makeCodexHome(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

/** Seed a template rollout whose session_meta the forge copies. */
function writeTemplateRollout(home: string, sessionId: string): string {
  const dir = path.join(home, 'sessions', '2026', '09', '06');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `rollout-2026-09-06T10-00-00-${sessionId}.jsonl`);
  fs.writeFileSync(
    filePath,
    [
      JSON.stringify({
        timestamp: '2026-09-06T10:00:00.000Z',
        ordinal: 0,
        type: 'session_meta',
        payload: {
          session_id: sessionId,
          id: sessionId,
          timestamp: '2026-09-06T10:00:00.000Z',
          cwd: '/home/user/project',
          originator: 'codex-tui',
          cli_version: '0.153.4',
          source: 'cli',
          // legacy templates (older CLI sessions) must be overridden to paginated
          history_mode: 'legacy',
          model_provider: 'openai',
          base_instructions: { text: 'You are Codex…' },
        },
      }),
      JSON.stringify({
        timestamp: '2026-09-06T10:00:01.000Z',
        ordinal: 1,
        type: 'event_msg',
        payload: { type: 'task_started' },
      }),
      JSON.stringify({
        timestamp: '2026-09-06T10:00:02.000Z',
        ordinal: 2,
        type: 'turn_context',
        payload: {
          turn_id: '11111111-aaaa-7bbb-8ccc-555555555555',
          root_turn_id: '11111111-aaaa-7bbb-8ccc-555555555555',
          cwd: '/home/user/project',
          workspace_roots: ['/home/user/project'],
          approval_policy: 'on-request',
          sandbox_policy: { type: 'workspace-write' },
        },
      }),
      JSON.stringify({
        timestamp: '2026-09-06T10:00:03.000Z',
        ordinal: 3,
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Template session' }] },
      }),
    ].join('\n') + '\n',
  );
  return filePath;
}

async function loadCodexParser(home: string): Promise<typeof import('../parsers/codex.js')> {
  vi.resetModules();
  vi.stubEnv('CODEX_HOME', home);
  return import('../parsers/codex.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

describe('codex rollout forge', () => {
  it('conversationToCodexItems maps messages with role-specific text types', async () => {
    const home = makeCodexHome('codex-forge-');
    const { conversationToCodexItems } = await loadCodexParser(home);

    const items = conversationToCodexItems([
      { role: 'system', content: 'system preamble' },
      { role: 'user', content: '帮我看看snip机制' },
      { role: 'assistant', content: '正在分析…' },
      { role: 'user', content: '   ' },
    ]);

    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '帮我看看snip机制' }],
      },
    });
    expect(items[1]).toEqual({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '正在分析…' }],
      },
    });
  });

  it('codexRolloutFileName mirrors codex native naming', async () => {
    const home = makeCodexHome('codex-forge-');
    const { codexRolloutFileName } = await loadCodexParser(home);
    expect(codexRolloutFileName('2026-09-07T05:46:41.123Z', '305a4a50-3f97-4ada-8659-f86802c53fda')).toBe(
      'rollout-2026-09-07T05-46-41-305a4a50-3f97-4ada-8659-f86802c53fda.jsonl',
    );
  });

  it('forgeCodexHandoffSession writes a resumable rollout with the source conversation', async () => {
    const home = makeCodexHome('codex-forge-');
    writeTemplateRollout(home, '11111111-2222-3333-4444-555555555555');
    const { forgeCodexHandoffSession } = await loadCodexParser(home);

    const session = {
      id: 'task-abc',
      source: 'qoder' as const,
      cwd: '/home/user/project',
      originalPath: '/nowhere.jsonl',
      summary: '介绍 nc workflow',
      createdAt: new Date(),
      updatedAt: new Date(),
      lines: 10,
      bytes: 1000,
    };
    const forged = forgeCodexHandoffSession(session, '/tmp/handoff.md', [
      { role: 'user', content: '介绍一下nc的workflow' },
      { role: 'assistant', content: '我先确认能力。' },
    ]);

    expect(forged).not.toBeNull();
    expect(forged!.prepopulated).toBe(2);
    expect(forged!.chatId).toMatch(/^[0-9a-f-]{36}$/);
    // Unified continuation title: 「续」+ source title (summary here — the
    // fixture session carries no native registry title)
    expect(forged!.taskName).toBe('续 介绍 nc workflow');

    // rollout exists under sessions/YYYY/MM/DD (today's tree), resumable shape
    const files = fs.readdirSync(path.join(home, 'sessions')).flatMap((y) =>
      fs.readdirSync(path.join(home, 'sessions', y)).flatMap((m) =>
        fs.readdirSync(path.join(home, 'sessions', y, m)).flatMap((d) =>
          fs.readdirSync(path.join(home, 'sessions', y, m, d)).map((f) => path.join(y, m, d, f)),
        ),
      ),
    );
    const forgedFile = files.find((f) => f.includes(forged!.chatId));
    expect(forgedFile).toBeTruthy();

    const lines = fs
      .readFileSync(path.join(home, 'sessions', forgedFile!), 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    // session_meta + turn structure: task_started, turn_context, then per
    // message a response_item + event_msg item_completed pair, closed by
    // task_complete — one turn (user+assistant) = 8 lines total
    expect(lines).toHaveLength(8);
    // session_meta rewritten onto the forged id + source cwd
    const meta = lines[0].payload as Record<string, unknown>;
    expect(meta.session_id).toBe(forged!.chatId);
    expect(meta.cwd).toBe('/home/user/project');
    expect(meta.originator).toBe('codex-cli');
    // history_mode must be forced to paginated on BOTH sides (threads row
    // + session_meta): mismatched modes break resume (list_turns -32601),
    // consistent legacy resumes but the desktop UI skips history loading
    expect(meta.history_mode).toBe('paginated');
    // base_instructions copied from the template so codex treats it natively
    expect((meta.base_instructions as { text?: string })?.text).toBe('You are Codex…');
    // turn structure: task_started → turn_context with a fresh turn_id
    expect((lines[1].payload as { type: string }).type).toBe('task_started');
    const turnContext = lines[2].payload as Record<string, unknown>;
    expect(turnContext.cwd).toBe('/home/user/project');
    expect(turnContext.turn_id).not.toBe('11111111-aaaa-7bbb-8ccc-555555555555');
    // each message: response_item (agent context) + item_completed (UI projection)
    const userResponse = lines[3].payload as Record<string, unknown>;
    const userEvent = lines[4].payload as Record<string, unknown>;
    expect(userResponse.role).toBe('user');
    const userItem = userEvent.item as Record<string, unknown>;
    expect(userEvent.type).toBe('item_completed');
    expect(userItem.type).toBe('UserMessage');
    expect((userItem.content as Array<{ type: string }>)[0].type).toBe('text');
    const assistantEvent = lines[6].payload as Record<string, unknown>;
    const agentItem = assistantEvent.item as Record<string, unknown>;
    expect(agentItem.type).toBe('AgentMessage');
    // AgentMessage uses capitalized Text blocks (codex's own event quirk)
    expect((agentItem.content as Array<{ type: string }>)[0].type).toBe('Text');
    // turn closed by task_complete carrying the turn_id
    const taskComplete = lines[7].payload as Record<string, unknown>;
    expect(taskComplete.type).toBe('task_complete');
    expect(taskComplete.turn_id).toBe(turnContext.turn_id);
    // ordinals strictly sequential
    expect(lines.map((l) => l.ordinal)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('folds window-leading assistant messages into a synthetic opening turn', async () => {
    const home = makeCodexHome('codex-forge-');
    writeTemplateRollout(home, '22222222-3333-4444-5555-666666666666');
    const { forgeCodexRolloutLines } = await loadCodexParser(home);

    // A 50-message window whose head is all assistant replies (the user turn
    // fell outside the window) — exactly the shape long sessions produce.
    const { lines, turnCount, messageCount } = forgeCodexRolloutLines(
      [
        { role: 'assistant', content: '尾部回复一' },
        { role: 'assistant', content: '尾部回复二' },
        { role: 'user', content: '新的提问' },
        { role: 'assistant', content: '新的回答' },
      ],
      'test-session-id',
      '/home/user/project',
      '2026-09-07T07:00:00.000Z',
      { model_provider: 'openai' },
      { cwd: '/home/user/project' },
    );

    expect(messageCount).toBe(4);
    expect(turnCount).toBe(2); // synthetic opening turn + the real user turn
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    // first turn opens without a preceding user message
    expect(parsed[1].type).toBe('event_msg');
    const firstContext = parsed[2].payload as Record<string, unknown>;
    const secondContext = (parsed.find(
      (l) => l.type === 'turn_context' && (l.payload as Record<string, unknown>).turn_id !== firstContext.turn_id,
    )?.payload ?? {}) as Record<string, unknown>;
    expect(secondContext.turn_id).toBeDefined();
  });

  it('returns null without messages or without a template rollout', async () => {
    const home = makeCodexHome('codex-forge-');
    const { forgeCodexHandoffSession } = await loadCodexParser(home);
    const session = {
      id: 'x',
      source: 'qoder' as const,
      cwd: '/p',
      originalPath: '/nonexistent.jsonl',
      createdAt: new Date(),
      updatedAt: new Date(),
      lines: 0,
      bytes: 0,
    };
    // no template → null even with messages
    expect(forgeCodexHandoffSession(session, '/tmp/h.md', [{ role: 'user', content: 'hi' }])).toBeNull();

    writeTemplateRollout(home, '99999999-8888-7777-6666-555555555555');
    // template but no messages → null
    expect(forgeCodexHandoffSession(session, '/tmp/h.md', [])).toBeNull();
  });
});
