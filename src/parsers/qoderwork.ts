import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { VerbosityConfig } from '../config/index.js';
import { getPreset } from '../config/index.js';
import { logger } from '../logger.js';
import type { ConversationMessage, SessionContext, SessionNotes, SessionParseOptions, UnifiedSession } from '../types/index.js';
import { extractTextFromBlocks, isRealUserMessage } from '../utils/content.js';
import { findFiles } from '../utils/fs-helpers.js';
import { getFileStats, readJsonlFile, scanJsonlFile, scanJsonlHead } from '../utils/jsonl.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { cleanSummary, extractRepoFromCwd, homeDir } from '../utils/parser-helpers.js';
import { launchGuiApp, openExternalUrl } from '../utils/platform.js';
import { continuedSessionTitle } from '../utils/session-title.js';
import { cwdFromSlug } from '../utils/slug.js';
import { extractAnthropicToolData, extractThinkingHighlights } from '../utils/tool-extraction.js';
import { buildQoderConversation, conversationToQoderLines, extractQoderPendingTasks, type QoderLine } from './qoder.js';

// ── QoderWork session shape ─────────────────────────────────────────────────
// QoderWork (quest/document agent) stores sessions under
// ~/.qoderwork/projects/<cwd-slug>/ as a pair of files per session:
// - <uuid>-session.json  — rich metadata (title, working_dir, token totals,
//                          created_at/updated_at epoch-ms, cost, …)
// - <uuid>.jsonl         — message body using the same Anthropic-style line
//                          format as Qoder transcripts. The first line is a
//   `workspace-directories` record carrying the workspace roots; other
//   bookkeeping lines (`active-leaf`, `runtime-config`, `last-prompt`) carry
//   no conversation content.
// Sessions without a message body (empty sessions) have no .jsonl and are
// skipped; orphan .jsonl files without a -session.json are still indexed.

interface QoderWorkMeta {
  id?: string;
  title?: string;
  working_dir?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_prompt_tokens?: number;
  total_completed_tokens?: number;
  total_cached_tokens?: number;
  created_at?: number;
  updated_at?: number;
}

const QODERWORK_PROJECTS_DIR = process.env.QODERWORK_HOME
  ? path.join(process.env.QODERWORK_HOME, 'projects')
  : path.join(homeDir(), '.qoderwork', 'projects');

/** Placeholder titles QoderWork writes before a session has a real name. */
const UNTITLED_SESSION = 'New Session';

// ── QoderWork chat registry (agents.db) ─────────────────────────────────────────
// Newer QoderWork builds no longer write the `-session.json` sidecar (sessions
// get a `<uuid>/` directory instead), so the authoritative chat title lives
// only in the app's SQLite registry: chats.name (AI-generated once the task
// settles), linked to transcripts through sub_chats.session_id. The index is
// best-effort — a missing or unreadable registry simply falls back to the
// sidecar/first-message title.

interface QoderWorkChatInfo {
  name: string | null;
  worktreePath: string | null;
  additionalDirectories: string | null;
  /** Epoch milliseconds (registry stores seconds). */
  createdAt: number | null;
  updatedAt: number | null;
}

function qoderWorkDbPath(): string {
  if (process.env.QODERWORK_DB_PATH) return process.env.QODERWORK_DB_PATH;
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(homeDir(), 'AppData', 'Roaming');
    return path.join(appData, 'QoderWork', 'data', 'agents.db');
  }
  return path.join(homeDir(), 'Library', 'Application Support', 'QoderWork', 'data', 'agents.db');
}

/** True when the QoderWork app is installed: bundle probe on macOS; its data
 *  store or MCP config existing (implies a prior run) elsewhere. */
export function qoderWorkAppInstalled(): boolean {
  if (process.platform === 'darwin') {
    return (
      fs.existsSync('/Applications/QoderWork.app') ||
      fs.existsSync(path.join(homeDir(), 'Applications', 'QoderWork.app'))
    );
  }
  return fs.existsSync(qoderWorkDbPath()) || fs.existsSync(path.join(homeDir(), '.qoderwork', 'mcp-adaptor.config'));
}

/** Chat registry keyed by both sub-chat session ids (transcript uuids) and
 *  chat ids — the parser's session id can be either depending on layout. */
function loadQoderWorkChatIndex(): Map<string, QoderWorkChatInfo> {
  const index = new Map<string, QoderWorkChatInfo>();
  try {
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(qoderWorkDbPath(), { open: true, timeout: 5_000 });
    try {
      const rows = db
        .prepare(
          'SELECT c.id AS chat_id, c.name, c.worktree_path, c.additional_directories,' +
            ' c.created_at, c.updated_at, s.session_id' +
            ' FROM chats c JOIN sub_chats s ON s.chat_id = c.id',
        )
        .all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        const info: QoderWorkChatInfo = {
          name:
            typeof row.name === 'string' && row.name.trim() && row.name !== UNTITLED_SESSION
              ? row.name.trim()
              : null,
          worktreePath: typeof row.worktree_path === 'string' ? row.worktree_path : null,
          additionalDirectories:
            typeof row.additional_directories === 'string' ? row.additional_directories : null,
          createdAt: typeof row.created_at === 'number' ? row.created_at * 1000 : null,
          updatedAt: typeof row.updated_at === 'number' ? row.updated_at * 1000 : null,
        };
        if (typeof row.session_id === 'string' && row.session_id) index.set(row.session_id, info);
        if (typeof row.chat_id === 'string' && row.chat_id) index.set(row.chat_id, info);
      }
    } finally {
      db.close();
    }
  } catch (err) {
    logger.debug('qoderwork: chat registry unavailable, falling back to file metadata', err);
  }
  return index;
}

function readSessionMeta(metaPath: string): QoderWorkMeta | null {
  try {
    const data = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (typeof data !== 'object' || data === null) return null;
    return data as QoderWorkMeta;
  } catch (err) {
    logger.debug('qoderwork: failed to read session meta', metaPath, err);
    return null;
  }
}

interface QoderWorkTranscriptInfo {
  sessionId: string;
  firstUserMessage: string;
  workspaceCwd: string;
  firstTimeMs?: number;
  lastTimeMs?: number;
  model?: string;
  hasConversation: boolean;
}

/**
 * Scan a QoderWork message-body JSONL for metadata: session id (from the
 * `workspace-directories` header), workspace cwd, first user message,
 * timestamps, and model.
 */
async function scanTranscript(filePath: string, options: SessionParseOptions = {}): Promise<QoderWorkTranscriptInfo> {
  let sessionId = '';
  let firstUserMessage = '';
  let workspaceCwd = '';
  let firstTimeMs: number | undefined;
  let lastTimeMs: number | undefined;
  let model: string | undefined;
  let hasConversation = false;

  const visitor = (parsed: unknown): 'continue' | 'stop' => {
    if (typeof parsed !== 'object' || parsed === null) return 'continue';
    const line = parsed as QoderLine;

    if (line.sessionId && !sessionId) sessionId = line.sessionId;
    if (!workspaceCwd && Array.isArray(line.directories)) {
      const first = line.directories.find((dir) => typeof dir === 'string' && dir);
      if (first) workspaceCwd = first;
    }

    const timeMs = typeof line.timestamp === 'string' ? Date.parse(line.timestamp) : Number.NaN;
    if (!Number.isNaN(timeMs)) {
      if (firstTimeMs === undefined || timeMs < firstTimeMs) firstTimeMs = timeMs;
      if (lastTimeMs === undefined || timeMs > lastTimeMs) lastTimeMs = timeMs;
    }

    const message = line.message;
    if (message && (line.type === 'user' || line.type === 'assistant')) {
      hasConversation = true;
      if (typeof message.model === 'string' && message.model && !model) model = message.model;

      if (!firstUserMessage && line.type === 'user') {
        const text = extractTextFromBlocks(message.content as string | Array<{ type: string; text?: string }>).trim();
        // "# Find Skills" marks QoderWork's harness-injected skill-discovery
        // prompt — a user-role line its own UI never displays.
        if (isRealUserMessage(text) && !text.startsWith('# Find Skills')) firstUserMessage = text;
      }
    }

    if (options.lightweight && sessionId && firstUserMessage) return 'stop';
    return 'continue';
  };

  if (options.lightweight) {
    await scanJsonlHead(filePath, 100, visitor);
  } else {
    await scanJsonlFile(filePath, visitor);
  }

  if (!sessionId) sessionId = path.basename(filePath, '.jsonl');

  return { sessionId, firstUserMessage, workspaceCwd, firstTimeMs, lastTimeMs, model, hasConversation };
}

/**
 * Parse all QoderWork sessions.
 */
export async function parseQoderWorkSessions(options: SessionParseOptions = {}): Promise<UnifiedSession[]> {
  const chatIndex = loadQoderWorkChatIndex();
  const metaFiles = findFiles(QODERWORK_PROJECTS_DIR, {
    match: (entry) => entry.name.endsWith('-session.json'),
    maxDepth: 2,
  });
  const jsonlFiles = findFiles(QODERWORK_PROJECTS_DIR, {
    match: (entry) => entry.name.endsWith('.jsonl'),
    maxDepth: 2,
  });

  const sessionsWithMeta = new Set(
    metaFiles.map((metaPath) => path.join(path.dirname(metaPath), `${path.basename(metaPath, '-session.json')}.jsonl`)),
  );

  const entries: Array<{ jsonlPath: string; meta: QoderWorkMeta | null }> = [];
  for (const metaPath of metaFiles) {
    const jsonlPath = metaPath.replace(/-session\.json$/, '.jsonl');
    if (!fs.existsSync(jsonlPath)) continue; // empty session without a message body
    entries.push({ jsonlPath, meta: readSessionMeta(metaPath) });
  }
  for (const jsonlPath of jsonlFiles) {
    if (!sessionsWithMeta.has(jsonlPath)) entries.push({ jsonlPath, meta: null }); // orphan transcript
  }

  const parsedSessions = await Promise.all(
    entries.map(async ({ jsonlPath, meta }): Promise<UnifiedSession | null> => {
      try {
        const info = await scanTranscript(jsonlPath, options);
        if (!info.hasConversation) return null;

        const fileStats = fs.statSync(jsonlPath);
        const stats = options.lightweight ? { lines: 0, bytes: fileStats.size } : await getFileStats(jsonlPath);

        const slug = path.basename(path.dirname(jsonlPath));
        const cwd = meta?.working_dir || info.workspaceCwd || cwdFromSlug(slug);

        // Title priority: -session.json sidecar > chat registry (chats.name,
        // the AI-generated task name shown in the QoderWork UI) > first user
        // prompt. Registry timestamps also win — title edits and task activity
        // touch them while the transcript file may sit idle.
        const chat = chatIndex.get(info.sessionId) ?? (meta?.id ? chatIndex.get(meta.id) : undefined) ?? null;
        const title = meta?.title && meta.title !== UNTITLED_SESSION ? meta.title : (chat?.name ?? '');
        const summary = cleanSummary(title || info.firstUserMessage);

        const nextSession: UnifiedSession = {
          id: meta?.id || info.sessionId,
          source: 'qoderwork',
          cwd,
          repo: cwd ? extractRepoFromCwd(cwd) : undefined,
          lines: stats.lines,
          bytes: fileStats.size,
          createdAt: new Date(
            meta?.created_at || chat?.createdAt || info.firstTimeMs || fileStats.birthtimeMs,
          ),
          updatedAt: new Date(
            meta?.updated_at || chat?.updatedAt || info.lastTimeMs || fileStats.mtimeMs,
          ),
          originalPath: jsonlPath,
          summary: summary || meta?.title || undefined,
          title: title || undefined,
          model: info.model,
        };

        return nextSession;
      } catch (err) {
        logger.debug('qoderwork: skipping unparseable session', jsonlPath, err);
        return null;
      }
    }),
  );

  return parsedSessions
    .filter((s): s is UnifiedSession => s !== null && (options.lightweight || s.lines > 1))
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

/**
 * Extract context from a QoderWork session for cross-tool continuation
 */
export async function extractQoderWorkContext(
  session: UnifiedSession,
  config?: VerbosityConfig,
): Promise<SessionContext> {
  const cfg = config ?? getPreset('standard');
  const lines = await readJsonlFile<QoderLine>(session.originalPath);

  // Extract tool data via shared Anthropic utility
  const { anthropicMsgs, recentMessages, timeline } = buildQoderConversation(lines);
  const { summaries: toolSummaries, filesModified } = extractAnthropicToolData(anthropicMsgs, cfg);
  const pendingTasks = extractQoderPendingTasks(anthropicMsgs, cfg.pendingTasks.maxTasks);

  const sessionNotes: SessionNotes = {};
  const modelMsg = lines.find((l) => typeof l.message?.model === 'string' && l.message.model);
  sessionNotes.model = modelMsg?.message?.model;

  // Companion -session.json carries authoritative metadata for this transcript
  const metaPath = session.originalPath.replace(/\.jsonl$/, '-session.json');
  const meta = fs.existsSync(metaPath) ? readSessionMeta(metaPath) : null;
  if (meta) {
    const inputTokens = meta.total_prompt_tokens || meta.prompt_tokens || 0;
    const outputTokens = meta.total_completed_tokens || meta.completion_tokens || 0;
    if (inputTokens > 0 || outputTokens > 0) {
      sessionNotes.tokenUsage = { input: inputTokens, output: outputTokens };
    }
    const cachedTokens = meta.total_cached_tokens || 0;
    if (cachedTokens > 0) {
      sessionNotes.cacheTokens = { creation: 0, read: cachedTokens };
    }
    sessionNotes.sourceMetadata = {
      ...(meta.title ? { sessionTitle: meta.title } : {}),
      ...(meta.working_dir ? { workingDir: meta.working_dir } : {}),
    };
  }

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

// ── QoderWork handoff-session forging ────────────────────────────────────────
// Full-auto handoff into the QoderWork GUI app: instead of asking the user to
// paste a prompt, we create a native task behind its back —
//   1. insert a chat row (+ sub_chat with an EMPTY session_id) into QoderWork's
//      SQLite store (~/Library/Application Support/QoderWork/data/agents.db)
//   2. pre-populate the messages table with the source conversation history
//      so the UI shows it on the task's first open (no app restart needed)
//   3. DO NOT trigger the agent — the user's first message in the UI continues
//      from the pre-populated history. (An MCP trigger would stream messages
//      into the renderer's in-memory cache and permanently shadow the
//      pre-populated rows — verified against QoderWork 0.9.15.)
//   4. bring the app to the foreground via `open -a`
// Verified end-to-end against QoderWork 0.9.15; schema drift across major
// versions is possible and handled by the try/catch fallback in resume.ts.

/** Result of a successful forge attempt */
export interface ForgedQoderWorkSession {
  chatId: string;
  taskName: string;
  /** Number of history messages pre-populated into the UI store (0 if none) */
  prepopulated: number;
}

interface QoderWorkMcpConfig {
  url?: string;
  token?: string;
}

/** Minimal typed interface for node:sqlite DatabaseSync (see opencode.ts) */
interface SqliteStatement {
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}
interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  close(): void;
}

function openQoderWorkDb(dbPath: string): { db: SqliteDb; close: () => void } | null {
  try {
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath, { open: true }) as SqliteDb;
    return { db, close: () => db.close() };
  } catch (err) {
    logger.debug('qoderwork: node:sqlite unavailable or db open failed', dbPath, err);
    return null;
  }
}

function randomId(length: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < length; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}


/**
 * Create a QoderWork task carrying the handoff instruction and trigger the
 * agent. Returns null when any precondition is missing (app not running, db
 * or MCP config absent, sqlite unavailable) — callers fall back to the
 * generic clipboard handoff.
 */


/**
 * Filter a source transcript line down to the lines both projections include.
 * The forged transcript and the pre-populated messages rows MUST use the same
 * filter: QoderWork's background backfill replaces DB rows with the SDK
 * projection whenever the SDK transcript holds MORE messages
 * (shouldReplaceProjectionFromSdk). Keeping both counts identical prevents
 * that replacement, so the pre-populated history stays rendered.
 */
function isForgeableConversationLine(line: QoderLine): boolean {
  if (line.isSidechain) return false;
  if (line.type !== 'user' && line.type !== 'assistant') return false;
  if (!line.message) return false;
  const content = line.message.content;
  if (typeof content === 'string') {
    const text = content.trim();
    return text.length > 0 && !text.startsWith('<');
  }
  if (Array.isArray(content)) {
    return content.some((block) => {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) return true;
      return (
        line.message?.role === 'assistant' &&
        block.type === 'thinking' &&
        typeof block.thinking === 'string' &&
        block.thinking.trim()
      );
    });
  }
  return false;
}

/**
 * Pre-populate QoderWork's messages table with the source conversation history
 * so the UI displays it on the task's first open — no app restart needed.
 *
 * QoderWork's `prepareProjectionForRead` checks countMessagesBySubChat: when
 * count > 0 it skips the blocking backfill, so our rows are returned directly.
 * Rows mirror the runtime's own projection shape (parts with ids, thinking as
 * tool-Thinking cards, assistant metadata with status fields) so the renderer
 * treats them like native messages.
 */
function prepopulateMessagesFromTranscript(
  db: SqliteDb,
  transcriptPath: string | undefined,
  chatId: string,
  subChatId: string,
  fallbackLines: QoderLine[],
): number {
  const lines = forgeableSourceLines(transcriptPath, fallbackLines);
  if (lines.length === 0) return 0;

  const insert = db.prepare(
    'INSERT OR IGNORE INTO messages' +
      ' (id, message_id, chat_id, sub_chat_id, sequence, role, parts, metadata,' +
      '  searchable_text, search_status, created_at, updated_at)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );

  const nowMs = Date.now();
  let sequence = 0;
  let written = 0;

  for (const line of lines) {
    const role = line.message!.role;
    const content = line.message!.content;
    const parts: Array<Record<string, unknown>> = [];

    if (typeof content === 'string') {
      if (content.trim() && !content.trim().startsWith('<')) {
        parts.push({ type: 'text', text: content });
      }
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          parts.push({ type: 'text', id: `text-${nowMs + sequence}-${written}`, text: block.text });
        } else if (
          role === 'assistant' &&
          block.type === 'thinking' &&
          typeof block.thinking === 'string' &&
          block.thinking.trim()
        ) {
          parts.push({
            type: 'tool-Thinking',
            toolCallId: `thinking-${nowMs + sequence}-${written}`,
            toolName: 'Thinking',
            parentToolUseId: null,
            input: { text: block.thinking },
            output: { completed: true },
            state: 'output-available',
          });
        }
        // tool_use / tool_result blocks are skipped: without paired context
        // they render as orphan cards, and the conversation text is what
        // matters for continuity.
      }
    }

    if (parts.length === 0) continue;

    // Skip user messages that are entirely system-injected content
    const textParts = parts.filter((p) => p.type === 'text' && typeof p.text === 'string');
    if (role === 'user' && textParts.length > 0) {
      const allText = textParts.map((p) => p.text as string).join('\n');
      if (allText.trim().startsWith('<')) continue;
    }

    const messageId = line.uuid || `conv-${subChatId}-${sequence}`;
    const rowId = `forge-${subChatId}-${sequence}`;
    const createdAt = line.timestamp
      ? typeof line.timestamp === 'number'
        ? line.timestamp
        : Math.floor(Date.parse(line.timestamp) / 1000)
      : Math.floor(nowMs / 1000);

    const metadata: Record<string, unknown> =
      role === 'assistant'
        ? {
            source: 'sdk-projection',
            assistantMessageId: messageId,
            status: 'completed',
            taskStatus: 'completed',
          }
        : { source: 'sdk-projection' };

    const searchableText = textParts.map((p) => p.text as string).join('\n');

    insert.run(
      rowId,
      messageId,
      chatId,
      subChatId,
      sequence,
      role,
      JSON.stringify(parts),
      JSON.stringify(metadata),
      searchableText,
      'ready',
      createdAt,
      createdAt,
    );
    sequence++;
    written++;
  }

  logger.debug(`qoderwork: pre-populated ${written} messages for ${subChatId}`);
  return written;
}




/**
 * Forge a QoderWork transcript carrying the source conversation so the agent
 * runtime resumes it with full context — the user's first message continues
 * from the complete history (thinking blocks included). Mirrors the native
 * line format; the parentUuid chain is rebuilt because the runtime walks it
 * to build model context (verified: unchained transcripts fail resume with
 * "Invalid session identifier").
 */
/** Parse a JSONL file into raw QoderLines (no filtering; best-effort). */
function readAnthropicLines(filePath: string): QoderLine[] {
  const lines: QoderLine[] = [];
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        lines.push(JSON.parse(line) as QoderLine);
      } catch {
        /* skip malformed lines */
      }
    }
  } catch {
    /* unreadable file → caller falls back */
  }
  return lines;
}

/**
 * Forgeable conversation lines for a handoff: the source transcript's own
 * lines when any survive the forge filter (same-family sources keep their
 * thinking/tool structure), otherwise the unified-conversation fallback
 * (per-message fidelity for any other source — codex, claude, …).
 */
function forgeableSourceLines(
  sourceTranscriptPath: string | undefined,
  fallbackLines: QoderLine[],
): QoderLine[] {
  const own = sourceTranscriptPath && fs.existsSync(sourceTranscriptPath)
    ? readAnthropicLines(sourceTranscriptPath).filter(isForgeableConversationLine)
    : [];
  if (own.length > 0) return own;
  return fallbackLines.filter(isForgeableConversationLine);
}

function forgeQoderWorkTranscript(
  sourceTranscriptPath: string | undefined,
  sessionId: string,
  worktree: string,
  fallbackLines: QoderLine[],
): number {
  const usable = forgeableSourceLines(sourceTranscriptPath, fallbackLines);
  if (usable.length === 0) return 0;

  const out: string[] = [
    JSON.stringify({ type: 'workspace-directories', sessionId, directories: [worktree] }),
    JSON.stringify({
      type: 'runtime-config',
      sessionId,
      model: 'qwork-ultimate',
      reasoningEffort: null,
      contextWindow: 1_000_000,
      generation: null,
      timestamp: Date.now(),
    }),
  ];
  let prevUuid: string | null = null;
  let count = 0;
  let lastUserText = '';

  for (const line of usable) {
    const content = line.message!.content;
    const uuid = line.uuid || `forge-${sessionId}-${count}`;

    if (line.type === 'user') {
      if (typeof content === 'string' && content.trim()) lastUserText = content;
      const humanText =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content
                .filter((b) => b.type === 'text' && typeof b.text === 'string')
                .map((b) => b.text)
                .join('\n')
            : '';
      out.push(
        JSON.stringify({
          type: 'user', sessionId, uuid, parentUuid: prevUuid,
          timestamp: line.timestamp, cwd: worktree, gitBranch: 'HEAD',
          isSidechain: false, userType: 'external', version: '1.1.26',
          entrypoint: 'cli', permissionMode: 'bypassPermissions',
          promptId: crypto.randomUUID(),
          humanInput: { text: humanText.slice(0, 200) },
          message: { role: 'user', content },
        }),
      );
    } else {
      const msg = { ...(line.message as object) } as Record<string, unknown>;
      if (typeof msg.id !== 'string') msg.id = `chatcmpl-${randomId(24)}`;
      msg.type = 'message';
      msg.role = 'assistant';
      if (typeof msg.model !== 'string') msg.model = 'qwork-auto';
      if (typeof msg.stop_reason !== 'string') msg.stop_reason = 'end_turn';
      if (msg.stop_sequence === undefined) msg.stop_sequence = null;
      out.push(
        JSON.stringify({
          type: 'assistant', sessionId, uuid, parentUuid: prevUuid,
          timestamp: line.timestamp, cwd: worktree, gitBranch: 'HEAD',
          isSidechain: false, userType: 'external', version: '1.1.26',
          entrypoint: 'cli', message: msg,
        }),
      );
    }
    prevUuid = uuid;
    count++;
  }

  if (count === 0) return 0;
  out.push(JSON.stringify({ type: 'last-prompt', sessionId, lastPrompt: lastUserText.slice(0, 500) }));
  out.push(
    JSON.stringify({
      type: 'active-leaf', sessionId, leafUuid: prevUuid, explicit: true,
      timestamp: new Date().toISOString(),
    }),
  );

  // Transcript location mirrors the native layout: the runtime resolves
  // --resume <sessionId> under ~/.qoderwork/projects/<worktree-slug>/.
  const slug = worktree.replace(/\\/g, '/').replace(/:/g, '').replace(/[/.]/g, '-');
  const dir = path.join(homeDir(), '.qoderwork', 'projects', slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), `${out.join('\n')}\n`, 'utf8');
  return count;
}

/** Name prefix for the sidebar-refresh marker task (self-cleaning across runs). */
const MARKER_PREFIX = '接续就绪（可删除）：';

/**
 * Remove marker tasks from previous handoffs (older than 10 minutes so an
 * in-flight marker is never touched). The next marker run refreshes the
 * sidebar from the DB, so deleted markers disappear from the list too.
 */
function cleanupOldMarkerTasks(db: SqliteDb, now: number): void {
  try {
    db.prepare("DELETE FROM messages WHERE chat_id IN (SELECT id FROM chats WHERE name LIKE ? AND updated_at < ?)")
      .run(`${MARKER_PREFIX}%`, now - 600);
    db.prepare("DELETE FROM sub_chats WHERE chat_id IN (SELECT id FROM chats WHERE name LIKE ? AND updated_at < ?)")
      .run(`${MARKER_PREFIX}%`, now - 600);
    db.prepare('DELETE FROM chats WHERE name LIKE ? AND updated_at < ?').run(`${MARKER_PREFIX}%`, now - 600);
  } catch (err) {
    logger.debug('qoderwork: marker cleanup failed', err);
  }
}

function callQoderWorkMcp(
  mcpUrl: string,
  token: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ success?: boolean; error?: string }> {
  return new Promise((resolve, reject) => {
    const base = mcpUrl.replace(/\/$/, '');
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    });
    const req = http.request(
      new URL(`${base}/mcp`),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': token,
          Accept: 'application/json, text/event-stream',
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk?: Buffer) => {
          body += chunk?.toString() ?? '';
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body) as {
              result?: { content?: Array<{ text?: string }> };
            };
            const text = parsed.result?.content?.[0]?.text ?? '{}';
            resolve(JSON.parse(text) as { success?: boolean; error?: string });
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error('MCP request timeout')));
    req.end(payload);
  });
}

/**
 * Open QoderWork's "all chats" view via its registered deeplink. This view
 * (and the Cmd+G search palette) re-query the DB on open — unlike the sidebar
 * list, whose cache never invalidates for externally-inserted rows — so the
 * forged task is immediately visible there. No Accessibility permission is
 * required (pure URL-scheme activation).
 */
function openAllChatsView(): void {
  openExternalUrl('qoder-work://all-chats');
}

export async function forgeQoderWorkHandoffSession(
  session: UnifiedSession,
  handoffPath: string,
  recentMessages: ConversationMessage[] = [],
): Promise<ForgedQoderWorkSession | null> {
  const supportDir =
    process.platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(homeDir(), 'AppData', 'Roaming'), 'QoderWork')
      : path.join(homeDir(), 'Library', 'Application Support', 'QoderWork');
  const dbPath = path.join(supportDir, 'data', 'agents.db');
  const mcpConfigPath = path.join(homeDir(), '.qoderwork', 'mcp-adaptor.config');
  if (!fs.existsSync(dbPath) || !fs.existsSync(mcpConfigPath)) {
    logger.debug('qoderwork: forge preconditions missing (db or mcp config)');
    return null;
  }

  let mcp: QoderWorkMcpConfig;
  try {
    mcp = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8')) as QoderWorkMcpConfig;
  } catch {
    return null;
  }
  if (!mcp.token || !mcp.url) return null;

  const opened = openQoderWorkDb(dbPath);
  if (!opened) return null;

  const chatId = `qw${randomId(14)}`;
  const subChatId = randomId(16);
  const sessionId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const sourceCwd = session.cwd || homeDir();
  // Unified continuation title: 「续」+ source title (native registry title >
  // summary > first user prompt).
  const taskName = continuedSessionTitle(session, recentMessages);
  const worktree = path.join(homeDir(), '.qoderwork', 'workspace', chatId);
  // Cross-source fallback lines: the unified conversation converted to the
  // Anthropic line shape (used only when the source transcript itself yields
  // no forgeable lines).
  const fallbackLines = conversationToQoderLines(recentMessages);


  try {
    fs.mkdirSync(worktree, { recursive: true });

    const project = opened.db.prepare('SELECT id FROM projects LIMIT 1').get() as { id: string } | undefined;
    if (!project) {
      opened.close();
      return null;
    }

    opened.db
      .prepare(
        'INSERT INTO chats (id, name, project_id, created_at, updated_at, worktree_path,' +
          ' additional_directories, output_directory, chat_type, ext)' +
          ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        chatId,
        taskName,
        project.id,
        now,
        now,
        worktree,
        JSON.stringify([sourceCwd]),
        path.join(worktree, 'outputs'),
        'task',
        // Mirror a natively-completed task: without taskStatus the renderer
        // treats the task as never-run and shows the empty composer state
        // instead of the pre-populated history.
        JSON.stringify({ activeLegokitId: 'task-monitor', taskStatus: 'completed' }),
      );
    // Forge the transcript BEFORE the sub_chats insert so we know whether
    // the session can be resumed (chain-rebuilt full history — the agent's
    // first reply then continues from the complete context).
    const transcriptCount = forgeQoderWorkTranscript(
      session.originalPath,
      sessionId,
      worktree,
      fallbackLines,
    );
    logger.debug(`qoderwork: forged transcript with ${transcriptCount} messages for session ${sessionId}`);

    opened.db
      .prepare(
        'INSERT INTO sub_chats (id, chat_id, session_id, mode, messages, created_at, updated_at, feedback)' +
          ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      // session_id points at the forged transcript: the user's first message
      // resumes it natively (full context). Empty fallback when no transcript
      // could be forged.
      .run(subChatId, chatId, transcriptCount > 0 ? sessionId : '', 'agent', '[]', now, now, 'none');

    // Sidebar refresh marker: a tiny sacrificial task whose agent run fires
    // task events that invalidate chats.list globally — the only way to make
    // an externally-inserted task appear in the sidebar without an app
    // restart (verified). The real task stays silent so its message cache
    // remains empty: the first open then loads the pre-populated history
    // from the DB (needsDbLoad is true while the cache has no user message).
    cleanupOldMarkerTasks(opened.db, now);
    const markerChatId = `qw${randomId(14)}`;
    const markerWorktree = path.join(homeDir(), '.qoderwork', 'workspace', markerChatId);
    fs.mkdirSync(markerWorktree, { recursive: true });
    // archived_at is set at creation so the marker never appears in the
    // sidebar or all-chats list (listChats filters archived_at IS NULL) —
    // its agent run still fires the task events that refresh the sidebar.
    opened.db
      .prepare(
        'INSERT INTO chats (id, name, project_id, created_at, updated_at, archived_at, worktree_path,' +
          ' additional_directories, output_directory, chat_type, ext)' +
          ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        markerChatId,
        `${MARKER_PREFIX}${(session.summary || 'session').slice(0, 30)}`,
        project.id,
        now,
        now,
        now,
        markerWorktree,
        '[]',
        path.join(markerWorktree, 'outputs'),
        'task',
        '{}',
      );
    opened.db
      .prepare(
        'INSERT INTO sub_chats (id, chat_id, session_id, mode, messages, created_at, updated_at, feedback)' +
          ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(randomId(16), markerChatId, '', 'agent', '[]', now, now, 'none');
    let prepopulated = prepopulateMessagesFromTranscript(
      opened.db,
      session.originalPath,
      chatId,
      subChatId,
      fallbackLines,
    );
    logger.debug(
      `qoderwork: forge pre-populated ${prepopulated} messages for chat ${chatId}`,
    );

    opened.close();

    // Fire the marker task's agent run — its task events refresh the sidebar,
    // surfacing the silent continuation task. Best effort: on failure the
    // task is still reachable via the all-chats palette (Cmd+G).
    const marker = await callQoderWorkMcp(mcp.url, mcp.token, 'qoder_send_message', {
      chatId: markerChatId,
      message: '请只回复：已就绪',
    });
    if (!marker.success) {
      logger.debug('qoderwork: marker trigger failed', marker.error);
    }

    // Activate the app on the all-chats view, which re-queries the DB on
    // mount — the forged task appears there without an app restart.
    launchGuiApp('QoderWork');
    openAllChatsView();

    return { chatId, taskName, prepopulated };
  } catch (err) {
    try {
      opened.close();
    } catch {
      /* already closed */
    }
    logger.debug('qoderwork: forge failed', err);
    return null;
  }
}
