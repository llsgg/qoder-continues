import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import type { VerbosityConfig } from '../config/index.js';
import { getPreset } from '../config/index.js';
import { logger } from '../logger.js';
import type {
  ConversationMessage,
  SessionContext,
  SessionEvent,
  SessionNotes,
  SessionParseOptions,
  UnifiedSession,
} from '../types/index.js';
import { extractTextFromBlocks, isRealUserMessage } from '../utils/content.js';
import { findFiles, mapConcurrent } from '../utils/fs-helpers.js';
import { getFileStats, readJsonlFile, scanJsonlFile, scanJsonlHead } from '../utils/jsonl.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { cleanSummary, extractRepoFromCwd, homeDir } from '../utils/parser-helpers.js';
import { isProcessRunning, launchGuiApp } from '../utils/platform.js';
import { continuedSessionTitle } from '../utils/session-title.js';
import { cwdFromSlug } from '../utils/slug.js';
import {
  type AnthropicMessage,
  extractAnthropicToolData,
  extractThinkingHighlights,
} from '../utils/tool-extraction.js';

// ── Qoder transcript shape ──────────────────────────────────────────────────
// Qoder (IDE + CLI) stores sessions under ~/.qoder/projects/<cwd-slug>/ in two layouts:
// - New (IDE):  <slug>/transcript/task-<id>.session.execution.jsonl
// - Old (CLI):  <slug>/<uuid>.jsonl
// Both share the same line format: JSONL records with `type` ("user", "assistant",
// "session_meta", "runtime-config", "progress", "hook_progress", …), optional
// `sessionId`/`cwd`/`uuid`/`parentUuid`, and an Anthropic-style `message` whose
// `content` is either a plain string (user prompts) or a block array
// (thinking / text / tool_use / tool_result / redacted_thinking).
// Timestamps are ISO strings in the new layout; the old layout also mixes in
// epoch-millisecond numbers on `runtime-config` lines.

interface QoderBlock {
  type: string;
  [key: string]: unknown;
}

interface QoderMessage {
  role: 'user' | 'assistant';
  model?: string;
  content: string | QoderBlock[];
}

export interface QoderLine {
  type: string;
  sessionId?: string;
  uuid?: string;
  parentUuid?: string;
  timestamp?: string | number;
  cwd?: string;
  isSidechain?: boolean;
  version?: string;
  entrypoint?: string;
  model?: string;
  /** QoderWork `workspace-directories` lines carry the open workspace roots */
  directories?: string[];
  message?: QoderMessage;
}

const QODER_PROJECTS_DIR = process.env.QODER_HOME
  ? path.join(process.env.QODER_HOME, 'projects')
  : path.join(homeDir(), '.qoder', 'projects');

/** New-layout transcript files live one level deeper than old-layout CLI files. */
const MAX_DEPTH = 3;

function qoderSlugFromCwd(cwd: string): string {
  return cwd.replace(/\\/g, '/').replace(/:/g, '').replace(/[/.]/g, '-');
}

function parseQoderTimestamp(value: string | number | undefined): number | undefined {
  if (typeof value === 'number') {
    // Epoch milliseconds (old-layout runtime-config lines)
    return value > 0 ? value : undefined;
  }
  if (typeof value === 'string' && value) {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return ms;
  }
  return undefined;
}

/**
 * Find all Qoder session JSONL files. Both layouts sit under a cwd-slug
 * project directory, so a cwd filter can scan a single slug directory.
 */
function findSessionFiles(options: SessionParseOptions = {}): string[] {
  const root = options.cwd ? path.join(QODER_PROJECTS_DIR, qoderSlugFromCwd(options.cwd)) : QODER_PROJECTS_DIR;

  return findFiles(root, {
    match: (entry) => entry.name.endsWith('.jsonl'),
    maxDepth: options.cwd ? MAX_DEPTH - 1 : MAX_DEPTH,
  });
}

/**
 * True when a user line carries human text (as opposed to only tool_result blocks).
 */
function hasHumanText(message: QoderMessage): boolean {
  if (typeof message.content === 'string') return message.content.trim().length > 0;
  return message.content.some((block) => block.type === 'text' && typeof block.text === 'string');
}

interface QoderSessionInfo {
  sessionId: string;
  cwd: string;
  firstUserMessage: string;
  firstTimeMs?: number;
  lastTimeMs?: number;
  model?: string;
  version?: string;
  entrypoint?: string;
  hasConversation: boolean;
}

/**
 * Parse session metadata and the first real user message from a transcript.
 */
async function parseSessionInfo(filePath: string, options: SessionParseOptions = {}): Promise<QoderSessionInfo | null> {
  let sessionId = '';
  let cwd = '';
  let firstUserMessage = '';
  let firstTimeMs: number | undefined;
  let lastTimeMs: number | undefined;
  let model: string | undefined;
  let version: string | undefined;
  let entrypoint: string | undefined;
  let hasConversation = false;

  const visitor = (parsed: unknown): 'continue' | 'stop' => {
    if (typeof parsed !== 'object' || parsed === null) return 'continue';
    const line = parsed as QoderLine;

    if (line.sessionId && !sessionId) sessionId = line.sessionId;
    if (line.cwd && !cwd) cwd = line.cwd;
    if (typeof line.version === 'string' && !version) version = line.version;
    if (typeof line.entrypoint === 'string' && !entrypoint) entrypoint = line.entrypoint;

    // Old-layout runtime-config lines carry the model and epoch-ms timestamps
    if (typeof line.model === 'string' && line.model && !model) model = line.model;

    const timeMs = parseQoderTimestamp(line.timestamp);
    if (timeMs !== undefined) {
      if (firstTimeMs === undefined || timeMs < firstTimeMs) firstTimeMs = timeMs;
      if (lastTimeMs === undefined || timeMs > lastTimeMs) lastTimeMs = timeMs;
    }

    const message = line.message;
    if (message && (line.type === 'user' || line.type === 'assistant')) {
      hasConversation = true;
      if (typeof message.model === 'string' && message.model && !model) model = message.model;

      if (!firstUserMessage && line.type === 'user' && hasHumanText(message)) {
        const text = extractTextFromBlocks(message.content as string | Array<{ type: string; text?: string }>);
        if (isRealUserMessage(text)) {
          firstUserMessage = text;
        }
      }
    }

    if (options.lightweight && sessionId && cwd && firstUserMessage) return 'stop';
    return 'continue';
  };

  if (options.lightweight) {
    await scanJsonlHead(filePath, 100, visitor);
  } else {
    await scanJsonlFile(filePath, visitor);
  }

  // Skip non-session files (canvases, agent tooling caches, …) that happen to
  // live under projects/ but never contain conversation lines.
  if (!hasConversation) return null;

  if (!sessionId) {
    sessionId = path.basename(filePath, '.jsonl');
  }
  if (!cwd) {
    // Fall back to the cwd-slug directory name shared by both layouts
    const dir = path.dirname(filePath);
    const slug = path.basename(dir) === 'transcript' ? path.basename(path.dirname(dir)) : path.basename(dir);
    cwd = cwdFromSlug(slug);
  }

  return { sessionId, cwd, firstUserMessage, firstTimeMs, lastTimeMs, model, version, entrypoint, hasConversation };
}

/**
 * Parse all Qoder sessions
 */
export async function parseQoderSessions(options: SessionParseOptions = {}): Promise<UnifiedSession[]> {
  const files = findSessionFiles(options);
  // Native titles from the New Qoder app's session registry, keyed by the
  // transcript session id (chat_sessions.title — the AI-generated name the
  // app's sidebar shows). Legacy IDE transcripts have no registry row and
  // keep falling back to the first-message summary.
  const titleIndex = loadNewQoderTitleIndex();
  const parsedSessions = await mapConcurrent(files, 16, async (filePath): Promise<UnifiedSession | null> => {
    try {
      const info = await parseSessionInfo(filePath, options);
      if (!info) return null;

      const fileStats = fs.statSync(filePath);
      const stats = options.lightweight ? { lines: 0, bytes: fileStats.size } : await getFileStats(filePath);
      const summary = cleanSummary(info.firstUserMessage);
      const title = titleIndex.get(info.sessionId);

      return {
        id: info.sessionId,
        source: 'qoder',
        cwd: info.cwd,
        repo: info.cwd ? extractRepoFromCwd(info.cwd) : undefined,
        lines: stats.lines,
        bytes: fileStats.size,
        createdAt: new Date(info.firstTimeMs ?? fileStats.birthtimeMs),
        updatedAt: new Date(info.lastTimeMs ?? fileStats.mtimeMs),
        originalPath: filePath,
        summary: summary || undefined,
        title,
        model: info.model,
      };
    } catch (err) {
      logger.debug('qoder: skipping unparseable session', filePath, err);
      return null;
    }
  });

  return parsedSessions
    .filter((s): s is UnifiedSession => s !== null && (options.lightweight || s.lines > 1))
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

/**
 * Extract pending tasks from the most recent TodoWrite tool call.
 * Qoder/QoderWork follow the Claude Code TodoWrite shape: { todos: [{ content, status }] }
 */
export function extractQoderPendingTasks(messages: AnthropicMessage[], maxTasks: number): string[] {
  let lastTodos: Array<{ content?: unknown; status?: unknown }> | undefined;
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type !== 'tool_use' || block.name !== 'TodoWrite') continue;
      const input = block.input as { todos?: Array<{ content?: unknown; status?: unknown }> } | undefined;
      if (Array.isArray(input?.todos)) lastTodos = input.todos;
    }
  }
  if (!lastTodos) return [];

  const tasks: string[] = [];
  for (const todo of lastTodos) {
    if (tasks.length >= maxTasks) break;
    const content = typeof todo.content === 'string' ? todo.content.trim() : '';
    if (!content) continue;
    const status = typeof todo.status === 'string' ? todo.status.toLowerCase() : '';
    if (status === 'in_progress' || status === 'pending') {
      tasks.push(content);
    }
  }
  return tasks;
}

export interface QoderConversation {
  anthropicMsgs: AnthropicMessage[];
  recentMessages: ConversationMessage[];
  timeline: SessionEvent[];
}

/**
 * Convert transcript lines into the unified conversation shape shared by
 * Qoder and QoderWork: Anthropic-style messages for tool extraction plus
 * human-readable messages/timeline for handoff rendering. Skips tool_result-only
 * user lines, subagent sidechain lines, and bookkeeping record types.
 */
export function buildQoderConversation(lines: QoderLine[]): QoderConversation {
  const anthropicMsgs: AnthropicMessage[] = lines
    .filter((l) => l.message && Array.isArray(l.message.content) && !l.isSidechain)
    .map((l) => ({ role: l.message!.role, content: l.message!.content as QoderBlock[] }));

  const recentMessages: ConversationMessage[] = [];
  const timeline: SessionEvent[] = [];
  let sequence = 0;

  for (const line of lines) {
    if ((line.type !== 'user' && line.type !== 'assistant') || !line.message || line.isSidechain) continue;
    if (line.type === 'user' && !hasHumanText(line.message)) continue;

    const content = extractTextFromBlocks(
      line.message.content as string | Array<{ type: string; text?: string }>,
    ).trim();
    if (!content) continue;

    const timeMs = parseQoderTimestamp(line.timestamp);
    const message: ConversationMessage = {
      role: line.type === 'user' ? 'user' : 'assistant',
      content,
      ...(timeMs !== undefined ? { timestamp: new Date(timeMs) } : {}),
      sourceId: line.uuid,
      sourceParentId: line.parentUuid,
    };
    recentMessages.push(message);
    timeline.push({
      kind: 'message',
      sequence: sequence++,
      role: message.role,
      content,
      timestamp: message.timestamp,
      sourceId: line.uuid,
      sourceParentId: line.parentUuid,
    });
  }

  return { anthropicMsgs, recentMessages, timeline };
}

/**
 * Extract context from a Qoder session for cross-tool continuation
 */
export async function extractQoderContext(session: UnifiedSession, config?: VerbosityConfig): Promise<SessionContext> {
  const cfg = config ?? getPreset('standard');
  const lines = await readJsonlFile<QoderLine>(session.originalPath);

  // Extract tool data via shared Anthropic utility
  const { anthropicMsgs, recentMessages, timeline } = buildQoderConversation(lines);
  const { summaries: toolSummaries, filesModified } = extractAnthropicToolData(anthropicMsgs, cfg);
  const pendingTasks = extractQoderPendingTasks(anthropicMsgs, cfg.pendingTasks.maxTasks);

  const sessionNotes: SessionNotes = {};
  const firstWithMeta = lines.find((l) => l.version || l.entrypoint);
  if (firstWithMeta) {
    sessionNotes.sourceMetadata = {
      ...(typeof firstWithMeta.version === 'string' ? { version: firstWithMeta.version } : {}),
      ...(typeof firstWithMeta.entrypoint === 'string' ? { entrypoint: firstWithMeta.entrypoint } : {}),
    };
  }
  const modelLine = lines.find((l) => typeof l.model === 'string' && l.model);
  sessionNotes.model = modelLine?.model ?? lines.find((l) => l.message?.model)?.message?.model;

  const reasoning = extractThinkingHighlights(anthropicMsgs, cfg.thinking.maxHighlights);
  if (reasoning.length > 0) sessionNotes.reasoning = reasoning;

  const trimmed = recentMessages.slice(-cfg.recentMessages);
  const enrichedSession: UnifiedSession = {
    ...session,
    model: session.model ?? sessionNotes.model,
  };

  const markdown = generateHandoffMarkdown(
    enrichedSession,
    trimmed,
    filesModified,
    pendingTasks,
    toolSummaries,
    sessionNotes,
    cfg,
    'inline',
    timeline,
  );

  return {
    session: enrichedSession,
    recentMessages: trimmed,
    filesModified,
    pendingTasks,
    toolSummaries,
    sessionNotes,
    timeline,
    markdown,
  };
}

// ── New Qoder handoff-session forging ────────────────────────────────────────
// Full-auto handoff into the New Qoder app (com.qoder.app, successor of the
// Qoder IDE). Verified against Qoder App 0.1.6: the app stores everything in
// one plaintext SQLite database plus the shared cosy transcript layout, so
// the forge works whether the app is running or not — no memento to fight,
// no account encryption to sidestep.
//   1. transcript ~/.qoder/projects/<cwd-slug>/<uuid>.jsonl — agent context
//      with a rebuilt parentUuid chain (the runtime resumes it natively when
//      the user first messages; same cosy runtime as QoderWork)
//   2. chat_sessions row — the session registry driving the sidebar
//   3. chat_session_messages rows with plaintext payload_json — UI history
//   4. chat_session_sidebar_placements row — pins the session to the top
//   5. workspaces row — created when the source cwd has no workspace yet
// When the app is already running, its renderer is reloaded in place (menu
// 显示 → 重新载入 clicked via System Events) so the sidebar catalog picks up
// the forged rows — the app itself never restarts.

export interface ForgedNewQoderSession {
  chatId: string;
  taskName: string;
  /** Plaintext UI-history messages written into chat_session_messages */
  prepopulated: number;
  /** True when the app was already running: writes persist (WAL) but the
   *  sidebar catalog only reloads on renderer reload (no external refresh
   *  channel — deep links cover mcp/invite only, verified 0.1.6). */
  appWasRunning: boolean;
  /** True when the app was already running and its renderer was reloaded
   *  (menu 显示 → 重新载入 via System Events) so the sidebar catalog picks up
   *  the forged rows — the app process, windows and login state all stay
   *  alive. False with appWasRunning=true means the reload could not be
   *  delivered (e.g. missing macOS Accessibility permission) — the user can
   *  reload the window manually. */
  refreshed: boolean;
}

interface SqliteStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): unknown;
}
interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  close(): void;
}

const NEW_QODER_APP_NAME = 'Qoder';
/** Windows process image name of the New Qoder app (Electron). */
const NEW_QODER_WIN_PROCESS = 'Qoder.exe';

/**
 * Plaintext SQLite registry of the New Qoder app (com.qoder.app.stable).
 * Electron's userData dir is `~/Library/Application Support/<name>` on macOS,
 * `%APPDATA%/<name>` on Windows and `~/.config/<name>` on Linux.
 * `QODER_APP_DB_PATH` overrides for non-standard installs.
 */
function newQoderAppDbPath(): string {
  if (process.env.QODER_APP_DB_PATH) return process.env.QODER_APP_DB_PATH;
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(homeDir(), 'AppData', 'Roaming');
    return path.join(appData, 'com.qoder.app.stable', 'main.sqlite');
  }
  if (process.platform === 'darwin') {
    return path.join(homeDir(), 'Library', 'Application Support', 'com.qoder.app.stable', 'main.sqlite');
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(homeDir(), '.config');
  return path.join(xdgConfig, 'com.qoder.app.stable', 'main.sqlite');
}

/** True when the New Qoder app is installed: bundle probe on macOS, its
 *  Electron userData dir existing (implies a prior launch) elsewhere. */
export function newQoderAppInstalled(): boolean {
  if (process.env.QODER_APP_DB_PATH) return fs.existsSync(process.env.QODER_APP_DB_PATH);
  if (process.platform === 'darwin') {
    return (
      fs.existsSync('/Applications/Qoder.app') || fs.existsSync(path.join(homeDir(), 'Applications', 'Qoder.app'))
    );
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(homeDir(), 'AppData', 'Roaming');
    return fs.existsSync(path.join(appData, 'com.qoder.app.stable'));
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(homeDir(), '.config');
  return fs.existsSync(path.join(xdgConfig, 'com.qoder.app.stable'));
}

/** Native session titles from the New Qoder app's chat registry (WAL-safe
 *  read; best-effort — a missing db or an unavailable node:sqlite simply
 *  yields an empty index and sessions keep their first-message summary). */
function loadNewQoderTitleIndex(): Map<string, string> {
  const index = new Map<string, string>();
  const dbPath = newQoderAppDbPath();
  if (!fs.existsSync(dbPath)) return index;
  const db = openNewQoderDb(dbPath);
  if (!db) return index;
  try {
    const rows = db.prepare('SELECT session_id, title FROM chat_sessions').all() as Array<{
      session_id?: unknown;
      title?: unknown;
    }>;
    for (const row of rows) {
      if (typeof row.session_id !== 'string' || !row.session_id) continue;
      if (typeof row.title !== 'string' || !row.title.trim()) continue;
      index.set(row.session_id, row.title.trim());
    }
  } catch (err) {
    logger.debug('qoder: chat_sessions title scan failed', err);
  } finally {
    db.close();
  }
  return index;
}

function openNewQoderDb(dbPath: string = newQoderAppDbPath()): SqliteDb | null {
  try {
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require('node:sqlite');
    // WAL mode: concurrent access from a running app is safe.
    return new DatabaseSync(dbPath, { open: true, timeout: 15_000 }) as SqliteDb;
  } catch (err) {
    logger.debug('qoder: node:sqlite unavailable or New Qoder db open failed', dbPath, err);
    return null;
  }
}

/**
 * Extract the human-authored text from a user line. Two qoderwork quirks:
 * - its runtime concatenates system-injected blocks (<system-reminder>
 *   environment info) with the real prompt inside ONE user line's block
 *   array, so blocks must be filtered individually — a whole-line `<` check
 *   would kill the real prompt;
 * - the "# Find Skills" prefix marks its harness-injected skill-discovery
 *   prompt, a user-role line the QoderWork UI itself never displays.
 */
function newQoderUserText(line: QoderLine): string | null {
  if (line.type !== 'user' || line.isSidechain || !line.message) return null;
  const content = line.message.content;
  let text: string;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .filter(
        (b) =>
          b.type === 'text' &&
          typeof b.text === 'string' &&
          b.text.trim() !== '' &&
          !b.text.trim().startsWith('<'),
      )
      .map((b) => (b.text as string).trim())
      .join('\n');
  } else {
    return null;
  }
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('<') || trimmed.startsWith('# Find Skills')) return null;
  return trimmed;
}

/** Assistant line reduced to text/thinking blocks (tool calls need result context). */
function newQoderAssistantBlocks(line: QoderLine): QoderBlock[] | null {
  if (line.type !== 'assistant' || line.isSidechain || !Array.isArray(line.message?.content)) {
    return null;
  }
  const kept = (line.message!.content as QoderBlock[]).filter(
    (b) =>
      (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) ||
      (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()),
  );
  return kept.length > 0 ? kept : null;
}

export interface NewQoderForgeData {
  /** Serialized transcript lines (bookkeeping + chained user/assistant) */
  transcriptLines: string[];
  /** UI-history messages in insertion order */
  messages: Array<{ role: 'user' | 'assistant'; text: string; turnId: string }>;
  lastUserText: string;
}

/**
 * Build the forged session's transcript and UI messages in one pass so both
 * projections stay content-identical. Exported for tests.
 */
export function forgeNewQoderSessionData(
  lines: QoderLine[],
  sessionId: string,
  cwd: string,
  startedAtMs: number,
): NewQoderForgeData {
  const baseTs = new Date(startedAtMs).toISOString();
  let seq = 0;
  const ts = (): string => new Date(startedAtMs + seq++ * 1000).toISOString();

  const transcript: Array<Record<string, unknown>> = [
    { type: 'workspace-directories', sessionId, directories: [cwd] },
    {
      type: 'runtime-config',
      sessionId,
      model: 'gmodel',
      reasoningEffort: null,
      contextWindow: null,
      generation: null,
      timestamp: startedAtMs,
    },
  ];

  const messages: NewQoderForgeData['messages'] = [];
  let prevUuid: string | null = null;
  let lastUserText = '';
  let currentTurnId: string | null = null;
  // The app's own projection aggregates an assistant turn's streamed text
  // fragments into ONE message — mirror that here so the initial rows match
  // what the app would project (it re-projects from the transcript anyway,
  // but aligned rows keep the pre-open state clean).
  let pendingAssistantText: string[] = [];
  const flushAssistant = (): void => {
    if (currentTurnId !== null && pendingAssistantText.length > 0) {
      messages.push({
        role: 'assistant',
        text: pendingAssistantText.join('\n\n'),
        turnId: currentTurnId,
      });
    }
    pendingAssistantText = [];
  };

  for (const line of lines) {
    const userText = newQoderUserText(line);
    if (userText !== null) {
      flushAssistant();
      const turnId = crypto.randomUUID();
      transcript.push({
        type: 'user',
        uuid: turnId,
        timestamp: ts(),
        message: { role: 'user', content: [{ type: 'text', text: userText }] },
        permissionMode: 'auto',
        origin: { kind: 'human' },
        promptId: crypto.randomUUID(),
        humanInput: { text: userText, mode: 'prompt' },
        requestSetId: turnId,
        parentUuid: prevUuid,
        isSidechain: false,
        cwd,
        sessionId,
        userType: 'external',
      });
      prevUuid = turnId;
      currentTurnId = turnId;
      lastUserText = userText;
      messages.push({ role: 'user', text: userText, turnId });
      continue;
    }

    const blocks = newQoderAssistantBlocks(line);
    if (blocks !== null && currentTurnId !== null) {
      const uuid = crypto.randomUUID();
      transcript.push({
        type: 'assistant',
        uuid,
        timestamp: ts(),
        message: {
          id: new Date(startedAtMs).toISOString().replace(/\D/g, '').slice(0, 17) + crypto.randomBytes(5).toString('hex'),
          type: 'message',
          role: 'assistant',
          model: 'gmodel',
          stop_reason: 'end_turn',
          stop_sequence: null,
          content: blocks,
        },
        parentUuid: prevUuid,
        isSidechain: false,
        cwd,
        sessionId,
        userType: 'external',
        entrypoint: 'cli',
      });
      prevUuid = uuid;
      const text = blocks
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text as string)
        .join('\n\n')
        .trim();
      if (text) pendingAssistantText.push(text);
    }
  }
  flushAssistant();

  transcript.push({ type: 'last-prompt', sessionId, lastPrompt: lastUserText });
  transcript.push({
    type: 'active-leaf',
    sessionId,
    leafUuid: prevUuid,
    explicit: false,
    timestamp: startedAtMs + seq * 1000,
  });

  return {
    transcriptLines: transcript.map((l) => JSON.stringify(l)),
    messages,
    lastUserText,
  };
}

/** User-message payload matching the app's own projection shape. */
function newQoderUserPayload(turnId: string, text: string, ts: string): string {
  return JSON.stringify({
    id: turnId,
    role: 'user',
    turnId,
    issueId: null,
    text,
    timestamp: ts,
    tools: [],
    attachments: [],
    selectedSkillNames: [],
    selectedPluginIds: [],
    selectedConnectorIds: [],
    selectedAgentNames: [],
    selectedCapabilityCommands: [],
    referencedChatSessions: [],
  });
}

/** Assistant-message payload matching the app's own projection shape. */
function newQoderAssistantPayload(turnId: string, text: string, ts: string): string {
  return JSON.stringify({
    id: `assistant:${turnId}`,
    role: 'assistant',
    turnId,
    requestSetId: turnId,
    text,
    timestamp: ts,
    tools: [],
    turnStartedAt: ts,
    durationMs: 0,
  });
}

/** Exact executable path of the New Qoder main process. Helper processes
 *  (Qoder Helper, crashpad, bundled daemons like daemon-server/mcp-bridge)
 *  share the .app path prefix but either live under Frameworks/ or carry
 *  extra argv — only the bare main path matches this constant. */
const NEW_QODER_MAIN_EXECUTABLE = '/Applications/Qoder.app/Contents/MacOS/Qoder';

/** Bundle id used for AppleScript activation — the display name "Qoder" is
 *  ambiguous because the older "Qoder IDE" app resolves to the same name. */
const NEW_QODER_BUNDLE_ID = 'com.qoder.app';

/** Parse `ps -axo pid=,comm=` output and return the pid of the New Qoder main
 *  process, or null when it is absent. Exported for tests. */
export function parseNewQoderMainPid(psOutput: string): number | null {
  for (const line of psOutput.split('\n')) {
    const trimmed = line.trim();
    const gap = trimmed.indexOf(' ');
    if (gap <= 0) continue;
    const pid = Number(trimmed.slice(0, gap));
    const comm = trimmed.slice(gap + 1).trim();
    if (Number.isInteger(pid) && pid > 0 && comm === NEW_QODER_MAIN_EXECUTABLE) return pid;
  }
  return null;
}

/** True when `pid` currently runs the New Qoder main executable. */
function isPidNewQoderMain(pid: number): boolean {
  try {
    const out = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8', timeout: 5000 });
    return out.status === 0 && out.stdout.trim() === NEW_QODER_MAIN_EXECUTABLE;
  } catch (err) {
    logger.debug('qoder: ps lookup failed', pid, err);
    return false;
  }
}

/** Pid of the New Qoder app as published by the app itself: the local MCP
 *  router writes ~/.qoder/mcp-router.json (schemaVersion 2) with the main
 *  process pid at startup. Falls back to null when the file is missing or the
 *  pid no longer belongs to the app (pids get reused). */
function newQoderRouterPid(): number | null {
  try {
    const routerPath = path.join(homeDir(), '.qoder', 'mcp-router.json');
    const parsed = JSON.parse(fs.readFileSync(routerPath, 'utf8')) as { pid?: unknown };
    const pid = parsed.pid;
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && isPidNewQoderMain(pid)
      ? pid
      : null;
  } catch {
    return null;
  }
}

/** Live pid of the New Qoder main process, or null when it is not running
 *  (non-darwin always null). Prefers the app's own mcp-router.json and falls
 *  back to a ps scan. */
export function newQoderAppPid(): number | null {
  if (process.platform !== 'darwin') return null;
  return newQoderRouterPid() ?? newQoderAppPidFromPs();
}

function newQoderAppPidFromPs(): number | null {
  try {
    const out = spawnSync('ps', ['-axo', 'pid=,comm='], { encoding: 'utf8', timeout: 5000 });
    if (out.status !== 0 || !out.stdout) return null;
    return parseNewQoderMainPid(out.stdout);
  } catch (err) {
    logger.debug('qoder: process enumeration failed', err);
    return null;
  }
}

/** AppleScript that activates the app by bundle id and clicks its View →
 *  Reload menu item (显示 → 重新载入), scoped to the exact process pid so the
 *  identically-named "Qoder IDE" app is never touched. Reload re-initializes
 *  the renderer and its sidebar catalog without restarting the app. Exported
 *  for tests. */
export function buildNewQoderReloadAppleScript(pid: number): string {
  return [
    'on run',
    `  tell application id "${NEW_QODER_BUNDLE_ID}" to activate`,
    '  delay 1.2',
    '  tell application "System Events"',
    `    tell (first application process whose unix id is ${pid})`,
    '      repeat with menuName in {"显示", "View", "查看", "视图"}',
    '        repeat with itemLabel in {"重新载入", "Reload"}',
    '          try',
    '            click (menu item itemLabel of menu 1 of menu bar item menuName of menu bar 1)',
    '            return "clicked"',
    '          end try',
    '        end repeat',
    '      end repeat',
    '    end tell',
    '  end tell',
    '  return "not-found"',
    'end run',
  ].join('\n');
}

/**
 * Reload the running app's renderer so its sidebar catalog picks up the
 * forged rows — the app process, windows, login state and background
 * sessions all stay alive (a quit + relaunch was the previous strategy, but
 * it threw away all app state). The View → Reload menu is clicked through
 * System Events, which requires the macOS Accessibility permission for the
 * terminal host; the click is attempted twice because the menu is dynamic
 * (workbench windows swap in a reduced menu) and may need a moment to settle
 * after activation. Verified against Qoder App 0.1.6.
 */
function reloadNewQoderRenderer(pid: number): boolean {
  const script = buildNewQoderReloadAppleScript(pid);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const click = spawnSync('osascript', ['-e', script], { encoding: 'utf8', timeout: 25_000 });
      if (click.status === 0 && click.stdout.trim() === 'clicked') return true;
      logger.debug('qoder: View→Reload click attempt failed', attempt, click.status, click.stderr);
    } catch (err) {
      logger.debug('qoder: View→Reload click attempt errored', attempt, err);
    }
  }
  return false;
}

const QODERWORK_WORKSPACE_PREFIX = () => path.join(homeDir(), '.qoderwork', 'workspace');
const QODERWORK_DB_PATH = () => {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(homeDir(), 'AppData', 'Roaming');
    return path.join(appData, 'QoderWork', 'data', 'agents.db');
  }
  return path.join(homeDir(), 'Library', 'Application Support', 'QoderWork', 'data', 'agents.db');
};

/** Placeholder titles QoderWork writes before a chat has a real name. */
const QODERWORK_UNTITLED = 'New Session';

/**
 * Resolve the source session's real project directory and native title for
 * qoderwork sources. QoderWork runs tasks in isolated workspaces
 * (~/.qoderwork/workspace/<id>); the actual project, when one is attached,
 * lives in chats.additional_directories. Returns cwd=null ONLY for isolated
 * workspaces with no attached project — pure-conversation tasks whose forged
 * session then joins the app's native "unassigned" list instead of spawning
 * a fake workspace per task (each isolated dir is unique, so every forge
 * would otherwise mint a new sidebar workspace group). Non-qoderwork sources
 * return the session's cwd and no title.
 */
function resolveQoderWorkContext(
  session: UnifiedSession,
): { cwd: string | null; title: string | null } {
  const cwd = session.cwd || process.cwd();
  if (session.source !== 'qoderwork') return { cwd, title: null };
  try {
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(QODERWORK_DB_PATH(), { open: true, timeout: 15_000 }) as SqliteDb;
    try {
      // The parser's session id is either the chat id or the transcript uuid
      // (sub_chats.session_id) — look the chat row up through both.
      const row = db
        .prepare(
          'SELECT name, additional_directories FROM chats WHERE id = ?\n' +
            'UNION ALL\n' +
            'SELECT c.name, c.additional_directories FROM chats c JOIN sub_chats s ON s.chat_id = c.id WHERE s.session_id = ?',
        )
        .get(session.id, session.id) as
        | { name?: string | null; additional_directories?: string | null }
        | undefined;
      const title =
        typeof row?.name === 'string' && row.name.trim() && row.name !== QODERWORK_UNTITLED
          ? row.name.trim()
          : null;
      if (!cwd.startsWith(QODERWORK_WORKSPACE_PREFIX() + path.sep)) {
        return { cwd, title };
      }
      // Isolated workspace: only an attached additional directory reveals the
      // real project — without one the task has no project dir at all.
      if (!row?.additional_directories) return { cwd: null, title };
      const dirs = JSON.parse(row.additional_directories) as unknown[];
      const real = dirs.find(
        (d): d is string =>
          typeof d === 'string' && d.length > 0 && !d.startsWith(QODERWORK_WORKSPACE_PREFIX()),
      );
      if (real) {
        logger.debug(`qoder: resolved real project dir ${real} for qoderwork session ${session.id}`);
        return { cwd: real, title };
      }
      return { cwd: null, title };
    } finally {
      db.close();
    }
  } catch (err) {
    logger.debug('qoder: qoderwork chat lookup failed', err);
    return { cwd, title: null };
  }
}

/** Best-effort current branch of the source cwd (null when not a git repo). */
function gitBranchOf(cwd: string): string | null {
  try {
    const out = spawnSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    if (out.status === 0 && out.stdout) return out.stdout.trim() || null;
  } catch {
    /* not a git repo */
  }
  return null;
}

/** Find or create the workspace row for cwd; returns its workspace_id. */
function ensureNewQoderWorkspace(db: SqliteDb, cwd: string, nowMs: number): string {
  const rows = db.prepare('SELECT workspace_id, root_paths_json FROM workspaces').all() as Array<{
    workspace_id: string;
    root_paths_json: string;
  }>;
  for (const row of rows) {
    try {
      const roots = JSON.parse(row.root_paths_json) as string[];
      if (Array.isArray(roots) && roots.includes(cwd)) return row.workspace_id;
    } catch {
      /* malformed row */
    }
  }
  const workspaceId = crypto.randomUUID();
  db.prepare(
    'INSERT OR REPLACE INTO workspaces' +
      ' (workspace_id, name, workspace_source, root_paths_json, extra_json, created_at, updated_at, archived)' +
      ' VALUES (?,?,?,?,?,?,?,?)',
  ).run(
    workspaceId,
    path.basename(cwd) || 'workspace',
    'local',
    JSON.stringify([cwd]),
    '{}',
    nowMs,
    nowMs,
    0,
  );
  return workspaceId;
}

/** Parse the source transcript as Anthropic-style lines (shared cosy shape). */
function readSourceQoderLines(session: UnifiedSession): QoderLine[] {
  if (!session.originalPath || !fs.existsSync(session.originalPath)) return [];
  try {
    return fs
      .readFileSync(session.originalPath, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as QoderLine)
      .filter((l) => l.type === 'user' || l.type === 'assistant');
  } catch (err) {
    logger.debug('qoder: source transcript unparseable for forge', session.originalPath, err);
    return [];
  }
}

/**
 * Convert unified conversation messages (any parser's recentMessages) into
 * Anthropic-style QoderLines so cross-tool sources (codex, claude, …) can be
 * forged with per-message fidelity instead of one big handoff blob. Exported
 * for the QoderWork forge and tests.
 */
export function conversationToQoderLines(
  messages: ConversationMessage[],
): QoderLine[] {
  return messages
    .filter((m) => m.role !== 'system' && m.content.trim())
    .map((m) => ({
      type: m.role === 'user' ? 'user' : 'assistant',
      ...(m.timestamp ? { timestamp: m.timestamp.toISOString() } : {}),
      message: {
        role: m.role === 'user' ? 'user' : 'assistant',
        content: [{ type: 'text', text: m.content }],
      },
    }));
}

/**
 * Create a native New Qoder chat session carrying the source conversation.
 * Returns null when preconditions are missing (non-macOS, app not installed)
 * — callers fall back to the generic clipboard handoff.
 */
export async function forgeNewQoderHandoffSession(
  session: UnifiedSession,
  handoffPath: string,
  recentMessages: ConversationMessage[] = [],
): Promise<ForgedNewQoderSession | null> {
  if (!fs.existsSync(newQoderAppDbPath())) return null;

  const db = openNewQoderDb();
  if (!db) return null;

  const sessionId = crypto.randomUUID();
  const { cwd: projectCwd, title } = resolveQoderWorkContext(session);
  // Storage cwd: the real project dir when resolved, otherwise the source
  // cwd (an isolated qoderwork dir is the task's factual working directory).
  // The runtime indexes transcripts by session id across all slug dirs, so
  // the location is bookkeeping only.
  const cwd = projectCwd ?? session.cwd ?? process.cwd();
  const nowMs = Date.now();
  // Unified continuation title: 「续」+ source title. `title` is the
  // freshly-read QoderWork registry name (qoderwork sources only); every
  // other source resolves through session.title > summary > first prompt.
  const taskName = continuedSessionTitle(session, recentMessages, title);

  try {
    // 1. Agent context, in fidelity order: the source transcript itself
    //    (Anthropic-shaped — same-family handoffs keep thinking/tool blocks),
    //    then the unified recentMessages (per-message fidelity for any other
    //    source), then the handoff document as one opening user message.
    let data = forgeNewQoderSessionData(readSourceQoderLines(session), sessionId, cwd, nowMs);
    if (data.messages.length === 0) {
      data = forgeNewQoderSessionData(
        conversationToQoderLines(recentMessages),
        sessionId,
        cwd,
        nowMs,
      );
    }
    if (data.messages.length === 0) {
      let markdown = '';
      try {
        markdown = fs.readFileSync(handoffPath, 'utf8').trim();
      } catch {
        /* fall through */
      }
      if (!markdown) return null;
      data = forgeNewQoderSessionData(
        [
          {
            type: 'user',
            message: { role: 'user', content: `请接续以下会话：\n\n${markdown}` },
          } as QoderLine,
        ],
        sessionId,
        cwd,
        nowMs,
      );
    }
    const transcriptPath = path.join(QODER_PROJECTS_DIR, qoderSlugFromCwd(cwd), `${sessionId}.jsonl`);
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.writeFileSync(transcriptPath, data.transcriptLines.join('\n') + '\n');

    // 2. Session registry row. registration_json MUST stay NULL — the
    //    sidebar's listSessions filters on `registration_json IS NULL` (the
    //    app uses a non-null value as a transient "input registration"
    //    marker that hides the session until it settles). Sessions with a
    //    resolved project dir join that project's workspace group; ones
    //    without (pure-conversation qoderwork tasks) get workspace_id NULL
    //    and appear in the app's native "unassigned" list instead of
    //    minting a throwaway workspace per task.
    const workspaceId = projectCwd ? ensureNewQoderWorkspace(db, projectCwd, nowMs) : null;
    db.prepare(
      'INSERT OR REPLACE INTO chat_sessions' +
        ' (session_id, origin_session_id, session_kind, owner_session_id,' +
        '  conversation_mode, product_mode, title, cwd, execution_kind, workspace_id,' +
        '  git_branch, model, permission_mode, additional_direcotries, extra_json,' +
        '  created_at, updated_at, execution_target_json, archived, unread)' +
        ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(
      sessionId,
      null,
      'standard',
      null,
      'normal',
      'coding',
      taskName,
      cwd,
      'local',
      workspaceId,
      gitBranchOf(cwd),
      'gmodel',
      'auto',
      '{}',
      JSON.stringify({
        provisionalTitle: taskName,
        titleResolved: true,
        titleSource: 'ai',
        titleRevision: 0,
      }),
      nowMs,
      nowMs,
      '{}',
      0,
      0,
    );

    // 3. UI history: plaintext payload rows (app renders them natively).
    const insertMessage = db.prepare(
      'INSERT OR REPLACE INTO chat_session_messages' +
        ' (session_id, message_id, turn_id, sequence, payload_json, status, feedback, source, created_at, updated_at)' +
        ' VALUES (?,?,?,?,?,?,?,?,?,?)',
    );
    let sequence = 0;
    for (const msg of data.messages) {
      sequence++;
      const ts = new Date(nowMs + sequence * 1000).toISOString();
      const payload =
        msg.role === 'user'
          ? newQoderUserPayload(msg.turnId, msg.text, ts)
          : newQoderAssistantPayload(msg.turnId, msg.text, ts);
      insertMessage.run(
        sessionId,
        msg.role === 'user' ? msg.turnId : `assistant:${msg.turnId}`,
        msg.turnId,
        sequence,
        payload,
        'completed',
        null,
        'sdk-projection',
        nowMs,
        nowMs,
      );
    }

    // 4. Pin to the top of the sidebar. work_directory is the sidebar-group
    //    key for manual ordering; NULL matches the unassigned bucket.
    db.prepare(
      'INSERT OR REPLACE INTO chat_session_sidebar_placements' +
        ' (session_id, work_directory, sort_order, pinned, updated_at)' +
        ' VALUES (?,?,?,?,?)',
    ).run(sessionId, projectCwd, 0, 0, nowMs);

    db.close();

    const appPid = newQoderAppPid();
    // 5. Surface the session. A cold start loads the sidebar catalog during
    //    renderer initialization; when the app is already running, reload its
    //    renderer (menu 显示 → 重新载入) so the catalog picks up the forged
    //    rows — without quitting the app. Windows has no scripted renderer
    //    reload (refreshed=false makes the CLI print the manual-reload hint).
    const appRunning =
      appPid !== null || (process.platform === 'win32' && isProcessRunning(NEW_QODER_WIN_PROCESS));
    if (!appRunning) {
      launchGuiApp(NEW_QODER_APP_NAME);
    }
    const refreshed = appRunning ? (appPid !== null ? reloadNewQoderRenderer(appPid) : false) : true;

    return {
      chatId: sessionId,
      taskName,
      prepopulated: data.messages.length,
      appWasRunning: appRunning,
      refreshed,
    };
  } catch (err) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    logger.debug('qoder: New Qoder forge failed', err);
    return null;
  }
}
