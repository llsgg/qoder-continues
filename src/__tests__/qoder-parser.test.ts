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

function writeLines(filePath: string, records: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
}

async function loadQoderParser(home: string): Promise<typeof import('../parsers/qoder.js')> {
  vi.resetModules();
  vi.stubEnv('QODER_HOME', home);
  return import('../parsers/qoder.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe('qoder parser', () => {
  it('indexes IDE-layout transcripts (transcript/task-*.session.execution.jsonl)', async () => {
    const home = makeTempHome('qoder-parser-');
    const cwd = '/home/user/project';
    const slug = '-home-user-project';
    const sessionId = 'task-abc123.session.execution';
    writeLines(path.join(home, 'projects', slug, 'transcript', `${sessionId}.jsonl`), [
      { type: 'session_meta', sessionId, uuid: 'u1', timestamp: '2026-01-15T10:00:00Z', cwd, data: {} },
      { type: 'progress', sessionId, uuid: 'u2', timestamp: '2026-01-15T10:00:00Z', cwd, data: { command: 'hook' } },
      {
        type: 'user',
        sessionId,
        uuid: 'u3',
        timestamp: '2026-01-15T10:00:01Z',
        cwd,
        message: { role: 'user', content: 'Fix the login bug' },
      },
      {
        type: 'assistant',
        sessionId,
        uuid: 'u4',
        timestamp: '2026-01-15T10:00:05Z',
        cwd,
        message: { role: 'assistant', content: [{ type: 'text', text: 'Fixed it.' }] },
      },
    ]);

    const { parseQoderSessions } = await loadQoderParser(home);
    const sessions = await parseQoderSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: sessionId,
      source: 'qoder',
      cwd,
      summary: 'Fix the login bug',
    });
    expect(sessions[0].createdAt.toISOString()).toBe('2026-01-15T10:00:00.000Z');
    expect(sessions[0].updatedAt.toISOString()).toBe('2026-01-15T10:00:05.000Z');
  });

  it('indexes old-layout CLI transcripts and picks up the runtime-config model', async () => {
    const home = makeTempHome('qoder-parser-');
    const sessionId = '11111111-2222-3333-4444-555555555555';
    writeLines(path.join(home, 'projects', '-home-user-project', `${sessionId}.jsonl`), [
      {
        type: 'runtime-config',
        sessionId,
        model: 'ultimate',
        reasoningEffort: 'max',
        contextWindow: 1000000,
        timestamp: 1768430400000,
      },
      {
        type: 'user',
        sessionId,
        uuid: 'u1',
        timestamp: '2026-01-15T10:00:01Z',
        cwd: '/home/user/project',
        message: { role: 'user', content: 'Refactor the parser' },
      },
      {
        type: 'assistant',
        sessionId,
        uuid: 'u2',
        timestamp: '2026-01-15T10:00:05Z',
        cwd: '/home/user/project',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
      },
    ]);

    const { parseQoderSessions } = await loadQoderParser(home);
    const sessions = await parseQoderSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(sessionId);
    expect(sessions[0].model).toBe('ultimate');
    expect(sessions[0].summary).toBe('Refactor the parser');
  });

  it('skips non-session JSONL files without conversation lines', async () => {
    const home = makeTempHome('qoder-parser-');
    writeLines(path.join(home, 'projects', '-home-user-project', 'canvas-data.jsonl'), [
      { type: 'canvas', nodes: [], timestamp: '2026-01-15T10:00:00Z' },
    ]);

    const { parseQoderSessions } = await loadQoderParser(home);
    expect(await parseQoderSessions()).toHaveLength(0);
  });

  it('extracts thinking highlights, tool data, and pending TodoWrite tasks', async () => {
    const home = makeTempHome('qoder-parser-');
    const sessionId = 'task-ctx.session.execution';
    const file = path.join(home, 'projects', '-home-user-project', 'transcript', `${sessionId}.jsonl`);
    writeLines(file, [
      { type: 'session_meta', sessionId, timestamp: '2026-01-15T10:00:00Z', cwd: '/home/user/project' },
      {
        type: 'user',
        sessionId,
        uuid: 'u1',
        timestamp: '2026-01-15T10:00:01Z',
        cwd: '/home/user/project',
        message: { role: 'user', content: 'Ship the feature' },
      },
      {
        type: 'assistant',
        sessionId,
        uuid: 'u2',
        timestamp: '2026-01-15T10:00:05Z',
        cwd: '/home/user/project',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'I should edit login.ts first, then run the tests.' },
            { type: 'text', text: 'Editing login.ts now.' },
            { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/home/user/project/login.ts' } },
            {
              type: 'tool_use',
              id: 't2',
              name: 'TodoWrite',
              input: {
                todos: [
                  { content: 'Edit login.ts', status: 'COMPLETED' },
                  { content: 'Run tests', status: 'IN_PROGRESS' },
                  { content: 'Update docs', status: 'PENDING' },
                ],
              },
            },
          ],
        },
      },
      {
        type: 'user',
        sessionId,
        uuid: 'u3',
        timestamp: '2026-01-15T10:00:06Z',
        cwd: '/home/user/project',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'edited', is_error: false }],
        },
      },
      {
        type: 'assistant',
        sessionId,
        uuid: 'u4',
        isSidechain: true,
        timestamp: '2026-01-15T10:00:07Z',
        cwd: '/home/user/project',
        message: { role: 'assistant', content: [{ type: 'text', text: 'subagent output' }] },
      },
    ]);

    const { parseQoderSessions, extractQoderContext } = await loadQoderParser(home);
    const [session] = await parseQoderSessions();
    const ctx = await extractQoderContext(session);

    // Thinking highlight captured (highlights are truncated to a fixed length)
    expect(ctx.sessionNotes?.reasoning?.[0]).toContain('edit login');

    // Tool activity captured
    const editSummary = ctx.toolSummaries.find((s) => s.name === 'Edit');
    expect(editSummary).toBeDefined();

    // Pending tasks from the last TodoWrite call
    expect(ctx.pendingTasks).toContain('Run tests');
    expect(ctx.pendingTasks).toContain('Update docs');
    expect(ctx.pendingTasks).not.toContain('Edit login.ts');

    // Conversation keeps human + assistant turns, drops tool_result-only user lines
    // and sidechain (subagent) lines
    expect(ctx.recentMessages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(ctx.recentMessages[1].content).toContain('Editing login.ts now.');
    expect(ctx.markdown).toContain('Ship the feature');
  });

  it('restricts discovery to the cwd slug when options.cwd is provided', async () => {
    const home = makeTempHome('qoder-parser-');
    const mk = (slug: string, text: string) => {
      const id = `task-${slug}.session.execution`;
      writeLines(path.join(home, 'projects', slug, 'transcript', `${id}.jsonl`), [
        { type: 'session_meta', sessionId: id, timestamp: '2026-01-15T10:00:00Z', cwd: `/home/user/${slug}` },
        {
          type: 'user',
          sessionId: id,
          uuid: 'u1',
          timestamp: '2026-01-15T10:00:01Z',
          cwd: `/home/user/${slug}`,
          message: { role: 'user', content: text },
        },
        {
          type: 'assistant',
          sessionId: id,
          uuid: 'u2',
          timestamp: '2026-01-15T10:00:02Z',
          cwd: `/home/user/${slug}`,
          message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        },
      ]);
    };
    mk('-home-user-alpha', 'alpha task');
    mk('-home-user-beta', 'beta task');

    const { parseQoderSessions } = await loadQoderParser(home);
    const sessions = await parseQoderSessions({ cwd: '/home/user/alpha' });

    expect(sessions).toHaveLength(1);
    expect(sessions[0].summary).toBe('alpha task');
  });
});

describe('New Qoder renderer reload', () => {
  it('parseNewQoderMainPid picks only the bare main executable', async () => {
    const home = makeTempHome('qoder-reload-');
    const { parseNewQoderMainPid } = await loadQoderParser(home);

    const psOutput = [
      '17681 /Applications/Qoder.app/Contents/MacOS/Qoder',
      '18873 /Applications/Qoder.app/Contents/MacOS/Qoder /Users/u/.qoder/plugins/cache/x.bundle.mjs daemon-server',
      '17684 /Applications/Qoder.app/Contents/Frameworks/Qoder Helper.app/Contents/MacOS/Qoder Helper',
      '17853 /Applications/Qoder IDE.app/Contents/Frameworks/Qoder Helper (Renderer).app/Contents/MacOS/Qoder Helper (Renderer)',
      '44949 /Applications/QoderWork.app/Contents/Frameworks/QoderWork Helper (Renderer).app/Contents/MacOS/QoderWork Helper',
      ' 9999 /Applications/Qoder.app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler',
    ].join('\n');

    expect(parseNewQoderMainPid(psOutput)).toBe(17681);
    // child processes sharing the binary path (extra argv) must not match
    expect(parseNewQoderMainPid('18873 /Applications/Qoder.app/Contents/MacOS/Qoder x.bundle.mjs daemon-server')).toBeNull();
    // the older Qoder IDE app must never match
    expect(parseNewQoderMainPid('17853 /Applications/Qoder IDE.app/Contents/MacOS/qoder-ide')).toBeNull();
    expect(parseNewQoderMainPid('')).toBeNull();
  });

  it('buildNewQoderReloadAppleScript targets the pid and the View → Reload menu', async () => {
    const home = makeTempHome('qoder-reload-');
    const { buildNewQoderReloadAppleScript } = await loadQoderParser(home);

    const script = buildNewQoderReloadAppleScript(4242);

    // activation by bundle id — the display name "Qoder" is ambiguous with Qoder IDE
    expect(script).toContain('tell application id "com.qoder.app" to activate');
    // System Events scoped to the exact pid, never by process name
    expect(script).toContain('first application process whose unix id is 4242');
    // zh + en menu/item labels
    expect(script).toContain('"显示"');
    expect(script).toContain('"View"');
    expect(script).toContain('"重新载入"');
    expect(script).toContain('"Reload"');
    // success/failure contract consumed by reloadNewQoderRenderer
    expect(script).toContain('return "clicked"');
    expect(script).toContain('return "not-found"');
  });
});
