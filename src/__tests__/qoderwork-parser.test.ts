import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const tempDirs: string[] = [];

function makeTempHome(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

function sessionDir(home: string): string {
  return path.join(home, 'projects', '-home-user-project');
}

function writeJsonl(filePath: string, lines: string[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
}

async function loadQoderWorkParser(
  home: string,
  dbPath = path.join(home, 'nonexistent-agents.db'),
): Promise<typeof import('../parsers/qoderwork.js')> {
  vi.resetModules();
  vi.stubEnv('QODERWORK_HOME', home);
  // Isolate the chat-registry lookup from the developer machine's real
  // QoderWork database; tests that need one pass an explicit path.
  vi.stubEnv('QODERWORK_DB_PATH', dbPath);
  return import('../parsers/qoderwork.js');
}

/** Minimal agents.db with just the columns the parser's registry lookup reads. */
function writeChatRegistry(
  dbPath: string,
  chats: Array<{ chatId: string; sessionId: string; name: string; createdAt: number; updatedAt: number }>,
): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const { createRequire } = require('node:module') as typeof import('node:module');
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
    DatabaseSync: new (p: string, opts?: { open?: boolean; timeout?: number }) => {
      exec(sql: string): void;
      prepare(sql: string): { run(...params: unknown[]): unknown };
      close(): void;
    };
  };
  const db = new DatabaseSync(dbPath);
  db.exec(
    'CREATE TABLE chats (id TEXT PRIMARY KEY, name TEXT, worktree_path TEXT,' +
      ' additional_directories TEXT, created_at INTEGER, updated_at INTEGER)',
  );
  db.exec(
    'CREATE TABLE sub_chats (id TEXT PRIMARY KEY, chat_id TEXT, session_id TEXT)',
  );
  for (const c of chats) {
    db.prepare('INSERT INTO chats (id, name, worktree_path, additional_directories, created_at, updated_at) VALUES (?,?,?,?,?,?)').run(
      c.chatId,
      c.name,
      null,
      null,
      c.createdAt,
      c.updatedAt,
    );
    db.prepare('INSERT INTO sub_chats (id, chat_id, session_id) VALUES (?,?,?)').run(
      `${c.chatId}-sub`,
      c.chatId,
      c.sessionId,
    );
  }
  db.close();
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe('qoderwork parser', () => {
  it('indexes paired -session.json + .jsonl sessions with rich metadata', async () => {
    const home = makeTempHome('qoderwork-parser-');
    const dir = sessionDir(home);
    fs.mkdirSync(dir, { recursive: true });
    const id = 'aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee';
    fs.writeFileSync(
      path.join(dir, `${id}-session.json`),
      JSON.stringify({
        id,
        title: 'Agent knowledge base design',
        working_dir: '/home/user/project',
        created_at: Date.parse('2026-01-15T10:00:00Z'),
        updated_at: Date.parse('2026-01-15T10:00:07Z'),
        total_prompt_tokens: 120,
        total_completed_tokens: 80,
      }),
    );
    writeJsonl(path.join(dir, `${id}.jsonl`), [
      JSON.stringify({ type: 'workspace-directories', sessionId: id, directories: ['/home/user/project'] }),
      JSON.stringify({
        type: 'user',
        sessionId: id,
        uuid: 'u1',
        timestamp: '2026-01-15T10:00:01Z',
        message: { role: 'user', content: 'Design the knowledge base' },
      }),
      JSON.stringify({
        type: 'assistant',
        sessionId: id,
        uuid: 'u2',
        timestamp: '2026-01-15T10:00:05Z',
        message: {
          role: 'assistant',
          model: 'qwork-auto',
          content: [{ type: 'text', text: 'Here is the design.' }],
        },
      }),
    ]);

    const { parseQoderWorkSessions, extractQoderWorkContext } = await loadQoderWorkParser(home);
    const sessions = await parseQoderWorkSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id,
      source: 'qoderwork',
      cwd: '/home/user/project',
      summary: 'Agent knowledge base design',
      title: 'Agent knowledge base design',
      model: 'qwork-auto',
    });

    const ctx = await extractQoderWorkContext(sessions[0]);
    expect(ctx.sessionNotes?.tokenUsage).toEqual({ input: 120, output: 80 });
    expect(ctx.sessionNotes?.model).toBe('qwork-auto');
  });

  it('falls back to the first user message when the title is a New Session placeholder', async () => {
    const home = makeTempHome('qoderwork-parser-');
    const dir = sessionDir(home);
    fs.mkdirSync(dir, { recursive: true });
    const id = 'bbbb2222-bbbb-cccc-dddd-eeeeeeeeeeee';
    fs.writeFileSync(
      path.join(dir, `${id}-session.json`),
      JSON.stringify({
        id,
        title: 'New Session',
        working_dir: '/home/user/project',
        created_at: Date.parse('2026-01-15T10:00:00Z'),
        updated_at: Date.parse('2026-01-15T10:00:07Z'),
      }),
    );
    writeJsonl(path.join(dir, `${id}.jsonl`), [
      JSON.stringify({ type: 'workspace-directories', sessionId: id, directories: ['/home/user/project'] }),
      JSON.stringify({
        type: 'user',
        sessionId: id,
        uuid: 'u1',
        timestamp: '2026-01-15T10:00:01Z',
        message: { role: 'user', content: 'Summarize the quarterly report' },
      }),
      JSON.stringify({
        type: 'assistant',
        sessionId: id,
        uuid: 'u2',
        timestamp: '2026-01-15T10:00:05Z',
        message: { role: 'assistant', model: 'qwork-auto', content: [{ type: 'text', text: 'Done.' }] },
      }),
    ]);

    const { parseQoderWorkSessions } = await loadQoderWorkParser(home);
    const sessions = await parseQoderWorkSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].summary).toBe('Summarize the quarterly report');
    // "New Session" placeholder → no native title, list falls back to summary
    expect(sessions[0].title).toBeUndefined();
  });

  it('skips empty sessions that have metadata but no message body', async () => {
    const home = makeTempHome('qoderwork-parser-');
    const dir = sessionDir(home);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'cccc3333-bbbb-cccc-dddd-eeeeeeeeeeee-session.json'),
      JSON.stringify({
        id: 'cccc3333-bbbb-cccc-dddd-eeeeeeeeeeee',
        title: 'Empty session',
        working_dir: '/home/user/project',
        created_at: Date.parse('2026-01-15T10:00:00Z'),
        updated_at: Date.parse('2026-01-15T10:00:01Z'),
      }),
    );

    const { parseQoderWorkSessions } = await loadQoderWorkParser(home);
    expect(await parseQoderWorkSessions()).toHaveLength(0);
  });

  it('indexes orphan transcripts that have no -session.json companion', async () => {
    const home = makeTempHome('qoderwork-parser-');
    const dir = sessionDir(home);
    fs.mkdirSync(dir, { recursive: true });
    const id = 'dddd4444-bbbb-cccc-dddd-eeeeeeeeeeee';
    writeJsonl(path.join(dir, `${id}.jsonl`), [
      JSON.stringify({ type: 'workspace-directories', sessionId: id, directories: ['/home/user/project'] }),
      JSON.stringify({
        type: 'user',
        sessionId: id,
        uuid: 'u1',
        timestamp: '2026-01-15T10:00:01Z',
        message: { role: 'user', content: 'Orphan task' },
      }),
      JSON.stringify({
        type: 'assistant',
        sessionId: id,
        uuid: 'u2',
        timestamp: '2026-01-15T10:00:05Z',
        message: { role: 'assistant', model: 'qwork-auto', content: [{ type: 'text', text: 'ok' }] },
      }),
    ]);

    const { parseQoderWorkSessions } = await loadQoderWorkParser(home);
    const sessions = await parseQoderWorkSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(id);
    expect(sessions[0].cwd).toBe('/home/user/project');
    expect(sessions[0].summary).toBe('Orphan task');
  });

  it('prefers the chat-registry task name over the first user message', async () => {
    const home = makeTempHome('qoderwork-parser-');
    const dir = sessionDir(home);
    fs.mkdirSync(dir, { recursive: true });
    const id = 'a1b2c3d4-bbbb-cccc-dddd-eeeeeeeeeeee';
    writeJsonl(path.join(dir, `${id}.jsonl`), [
      JSON.stringify({ type: 'workspace-directories', sessionId: id, directories: ['/home/user/project'] }),
      JSON.stringify({
        type: 'user',
        sessionId: id,
        uuid: 'u1',
        timestamp: '2026-01-15T10:00:01Z',
        message: { role: 'user', content: '介绍一下nc的workflow' },
      }),
      JSON.stringify({
        type: 'assistant',
        sessionId: id,
        uuid: 'u2',
        timestamp: '2026-01-15T10:00:05Z',
        message: { role: 'assistant', model: 'qwork-auto', content: [{ type: 'text', text: 'ok' }] },
      }),
    ]);
    const dbPath = path.join(home, 'data', 'agents.db');
    writeChatRegistry(dbPath, [
      {
        chatId: 'chat0001',
        sessionId: id,
        name: '介绍 nc workflow 和可信交付',
        createdAt: 1763000000,
        updatedAt: 1763000100,
      },
    ]);

    const { parseQoderWorkSessions } = await loadQoderWorkParser(home, dbPath);
    const sessions = await parseQoderWorkSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].summary).toBe('介绍 nc workflow 和可信交付');
    // registry timestamps (seconds → ms) win over transcript/file times
    expect(sessions[0].createdAt.getTime()).toBe(1763000000_000);
    expect(sessions[0].updatedAt.getTime()).toBe(1763000100_000);
  });

  it('skips the harness-injected "# Find Skills" prompt when picking the first user message', async () => {
    const home = makeTempHome('qoderwork-parser-');
    const dir = sessionDir(home);
    fs.mkdirSync(dir, { recursive: true });
    const id = 'b2c3d4e5-bbbb-cccc-dddd-eeeeeeeeeeee';
    writeJsonl(path.join(dir, `${id}.jsonl`), [
      JSON.stringify({ type: 'workspace-directories', sessionId: id, directories: ['/home/user/project'] }),
      JSON.stringify({
        type: 'user',
        sessionId: id,
        uuid: 'u1',
        timestamp: '2026-01-15T10:00:01Z',
        message: { role: 'user', content: '# Find Skills\nThis is a unified skill discovery…' },
      }),
      JSON.stringify({
        type: 'user',
        sessionId: id,
        uuid: 'u2',
        timestamp: '2026-01-15T10:00:02Z',
        message: { role: 'user', content: '介绍一下nc的workflow' },
      }),
      JSON.stringify({
        type: 'assistant',
        sessionId: id,
        uuid: 'u3',
        timestamp: '2026-01-15T10:00:05Z',
        message: { role: 'assistant', model: 'qwork-auto', content: [{ type: 'text', text: 'ok' }] },
      }),
    ]);

    const { parseQoderWorkSessions } = await loadQoderWorkParser(home);
    const sessions = await parseQoderWorkSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].summary).toBe('介绍一下nc的workflow');
  });

  it('extracts thinking highlights and tool activity from the message body', async () => {
    const home = makeTempHome('qoderwork-parser-');
    const dir = sessionDir(home);
    fs.mkdirSync(dir, { recursive: true });
    const id = 'eeee5555-bbbb-cccc-dddd-eeeeeeeeeeee';
    writeJsonl(path.join(dir, `${id}.jsonl`), [
      JSON.stringify({ type: 'workspace-directories', sessionId: id, directories: ['/home/user/project'] }),
      JSON.stringify({
        type: 'user',
        sessionId: id,
        uuid: 'u1',
        timestamp: '2026-01-15T10:00:01Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Reorganize the memory entries' }],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        sessionId: id,
        uuid: 'u2',
        timestamp: '2026-01-15T10:00:05Z',
        message: {
          role: 'assistant',
          model: 'qwork-auto',
          content: [
            { type: 'thinking', thinking: 'The memory entries need deduplication before restructuring.' },
            { type: 'text', text: 'Restructuring now.' },
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -la' } },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        sessionId: id,
        uuid: 'u3',
        timestamp: '2026-01-15T10:00:06Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file list', is_error: false }],
        },
      }),
      JSON.stringify({
        type: 'active-leaf',
        sessionId: id,
        uuid: 'u4',
        timestamp: '2026-01-15T10:00:06Z',
      }),
    ]);

    const { parseQoderWorkSessions, extractQoderWorkContext } = await loadQoderWorkParser(home);
    const [session] = await parseQoderWorkSessions();
    const ctx = await extractQoderWorkContext(session);

    expect(ctx.sessionNotes?.reasoning?.[0]).toContain('deduplication');
    expect(ctx.toolSummaries.find((s) => s.name === 'Bash')).toBeDefined();
    expect(ctx.recentMessages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });
});
