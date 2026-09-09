import * as crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { VerbosityConfig } from '../config/index.js';
import { getPreset } from '../config/index.js';
import { logger } from '../logger.js';
import type {
  ConversationMessage,
  SessionContext,
  SessionEvent,
  SessionNotes,
  SessionParseOptions,
  ToolUsageSummary,
  UnifiedSession,
} from '../types/index.js';
import type { CodexMessage, CodexSessionMeta } from '../types/schemas.js';
import { countDiffStats, extractStdoutTail } from '../utils/diff.js';
import { findFiles, mapConcurrent } from '../utils/fs-helpers.js';
import { getFileStats, readJsonlFile, scanJsonlFile, scanJsonlHead } from '../utils/jsonl.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { cleanSummary, extractRepo, homeDir } from '../utils/parser-helpers.js';
import { isProcessRunning, launchGuiApp } from '../utils/platform.js';
import { continuedSessionTitle } from '../utils/session-title.js';
import { matchesCwd } from '../utils/slug.js';
import {
  extractExitCode,
  fileSummary,
  mcpSummary,
  SummaryCollector,
  searchSummary,
  shellSummary,
  truncate,
  withResult,
} from '../utils/tool-summarizer.js';

const CODEX_HOME_DIR = process.env.CODEX_HOME || path.join(homeDir(), '.codex');
const CODEX_SESSIONS_DIR = path.join(CODEX_HOME_DIR, 'sessions');
const CODEX_ARCHIVED_SESSIONS_DIR = path.join(CODEX_HOME_DIR, 'archived_sessions');

const MAX_EXACT_LINE_COUNT_BYTES = 1024 * 1024;
const MAX_METADATA_SCAN_BYTES = 1024 * 1024;

/**
 * Find all Codex session files recursively
 */
async function findSessionFiles(): Promise<string[]> {
  return [CODEX_SESSIONS_DIR, CODEX_ARCHIVED_SESSIONS_DIR].flatMap((dir) =>
    findFiles(dir, {
      match: (entry) => entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl'),
    }),
  );
}

/**
 * Parse session metadata and first user message
 */
async function parseSessionInfo(filePath: string): Promise<{
  meta: CodexSessionMeta | null;
  firstUserMessage: string;
}> {
  let meta: CodexSessionMeta | null = null;
  let firstUserMessage = '';

  await scanJsonlHead(
    filePath,
    500,
    (parsed) => {
      const msg = parsed as Record<string, unknown>;

      if (msg.type === 'session_meta' && !meta) {
        meta = msg as unknown as CodexSessionMeta;
      }

      if (!firstUserMessage && msg.type === 'event_msg') {
        const payload = msg.payload as Record<string, unknown> | undefined;
        if (payload?.type === 'user_message') {
          firstUserMessage = (payload.message as string) || '';
        }
      }

      // Newer Codex rollouts only carry user input as response_item rows
      // (no event_msg user_message at all) — extract their text blocks.
      if (!firstUserMessage && msg.type === 'response_item') {
        const payload = msg.payload as Record<string, unknown> | undefined;
        if (payload?.role === 'user') {
          const content = payload.content;
          const text = Array.isArray(content)
            ? (content as Array<Record<string, unknown>>)
                .map((b) => (typeof b.text === 'string' ? b.text : ''))
                .join('')
            : typeof content === 'string'
              ? content
              : '';
          const trimmed = text.trim();
          // Skip harness-injected rows (<recommended_plugins>,
          // <environment_context>, …) — only real prompts count.
          if (trimmed && !trimmed.startsWith('<')) firstUserMessage = trimmed;
        }
      }

      if (msg.type === 'message' && (msg as Record<string, unknown>).role === 'user') {
        const content = (msg as Record<string, unknown>).content;
        if (!firstUserMessage && typeof content === 'string') {
          firstUserMessage = content;
        }
      }

      if (meta && firstUserMessage) {
        return 'stop';
      }
      return 'continue';
    },
    { maxBytes: MAX_METADATA_SCAN_BYTES },
  );

  return { meta, firstUserMessage };
}

/**
 * Extract session ID and timestamp from filename
 * Format: rollout-YYYY-MM-DDTHH-MM-SS-<uuid>.jsonl
 */
function parseFilename(filename: string): { timestamp: Date; id: string } | null {
  const match = filename.match(/rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(.+)\.jsonl$/);
  if (!match) return null;

  const [, year, month, day, hour, min, sec, id] = match;
  const timestamp = new Date(`${year}-${month}-${day}T${hour}:${min}:${sec}Z`);

  return { timestamp, id };
}

/** Native thread titles from the desktop app's registry (state_5.sqlite).
 *  Best-effort: a missing db (CLI-only installs) or an unavailable
 *  node:sqlite yields an empty index. Rows with an empty title — the norm for
 *  CLI-created threads — are skipped so the summary fallback stays in charge. */
function loadCodexThreadTitles(): Map<string, string> {
  const index = new Map<string, string>();
  try {
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(CODEX_HOME_DIR, 'state_5.sqlite'), {
      open: true,
      timeout: 5_000,
    }) as SqliteDb;
    try {
      const rows = db.prepare('SELECT id, title FROM threads').all() as Array<{
        id?: unknown;
        title?: unknown;
      }>;
      for (const row of rows) {
        if (typeof row.id !== 'string' || !row.id) continue;
        if (typeof row.title !== 'string' || !row.title.trim()) continue;
        index.set(row.id, row.title.trim());
      }
    } finally {
      db.close();
    }
  } catch (err) {
    logger.debug('codex: threads title scan unavailable', err);
  }
  return index;
}

/**
 * Parse all Codex sessions
 */
export async function parseCodexSessions(options: SessionParseOptions = {}): Promise<UnifiedSession[]> {
  const files = await findSessionFiles();
  // Native titles from the desktop app's threads registry (threads.title,
  // keyed by rollout session id). CLI-only rollouts have no registry row —
  // and CLI-created rows often store an empty title — so they keep the
  // first-message summary.
  const titleIndex = loadCodexThreadTitles();
  const parsedSessions = await mapConcurrent(files, 16, async (filePath): Promise<UnifiedSession | null> => {
    try {
      const filename = path.basename(filePath);
      const parsed = parseFilename(filename);
      if (!parsed) return null;

      const { meta, firstUserMessage } = await parseSessionInfo(filePath);
      const fileStats = fs.statSync(filePath);
      const stats =
        options.lightweight || fileStats.size > MAX_EXACT_LINE_COUNT_BYTES
          ? { lines: 0, bytes: fileStats.size }
          : await getFileStats(filePath);

      const payloadRecord = meta?.payload as Record<string, unknown> | undefined;
      const cwd = meta?.payload?.cwd || '';
      if (options.cwd && cwd && !matchesCwd(cwd, options.cwd)) return null;

      const gitUrl = meta?.payload?.git?.repository_url;
      const branch = meta?.payload?.git?.branch;
      const gitSha = meta?.payload?.git?.commit_hash || meta?.payload?.git?.sha;
      const repo = extractRepo({ gitUrl, cwd });
      const lastTranscriptTimestamp =
        !options.lightweight && fileStats.size <= MAX_METADATA_SCAN_BYTES
          ? await extractLastCodexTimestamp(filePath)
          : undefined;

      const summary = cleanSummary(firstUserMessage);
      const title = titleIndex.get(parsed.id);

      return {
        id: parsed.id,
        source: 'codex',
        cwd,
        repo,
        branch,
        gitSha,
        lines: stats.lines,
        bytes: stats.bytes,
        createdAt:
          parseValidDate(typeof payloadRecord?.timestamp === 'string' ? payloadRecord.timestamp : undefined) ??
          parseValidDate(meta?.timestamp) ??
          parsed.timestamp,
        updatedAt: lastTranscriptTimestamp ?? fileStats.mtime,
        originalPath: filePath,
        summary: summary || undefined,
        title,
      };
    } catch (err) {
      logger.debug('codex: skipping unparseable session', filePath, err);
      // Skip files we can't parse
      return null;
    }
  });

  const sessionsById = new Map<string, UnifiedSession>();
  for (const nextSession of parsedSessions) {
    if (!nextSession) continue;
    const existing = sessionsById.get(nextSession.id);
    if (!existing || existing.updatedAt.getTime() < nextSession.updatedAt.getTime()) {
      sessionsById.set(nextSession.id, nextSession);
    }
  }

  const sorted = Array.from(sessionsById.values()).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  return options.limit ? sorted.slice(0, options.limit) : sorted;
}

/**
 * Read all messages from a Codex session
 */
async function readAllMessages(filePath: string): Promise<CodexMessage[]> {
  return readJsonlFile<CodexMessage>(filePath);
}

/**
 * Common shell tool base commands for category grouping
 */
const COMMON_SHELL_TOOLS = new Set([
  'npm',
  'git',
  'node',
  'python',
  'find',
  'grep',
  'cat',
  'ls',
  'tree',
  'mkdir',
  'rm',
  'sed',
  'awk',
  'curl',
  'wget',
  'docker',
  'make',
  'cargo',
  'go',
  'pip',
  'pnpm',
  'yarn',
  'bun',
  'deno',
]);

function isCodexEditTool(name: string): boolean {
  return name === 'edit_file' || name.endsWith('__edit_file');
}

/**
 * Track file modifications from shell command patterns (sed -i, >, tee, mv, cp)
 */
function trackShellFileWrites(cmd: string, collector: SummaryCollector): void {
  const sedMatch = cmd.match(/sed\s+-i[^'"]*\s+[^'"]*\s+['"]?([^\s'"]+)/);
  if (sedMatch) {
    collector.trackFile(sedMatch[1]);
    return;
  }
  const redirectMatch = cmd.match(/>\s*['"]?([^\s;|&'"]+)/);
  if (redirectMatch && !redirectMatch[1].startsWith('>')) {
    collector.trackFile(redirectMatch[1]);
    return;
  }
  const teeMatch = cmd.match(/tee\s+['"]?([^\s;|&'"]+)/);
  if (teeMatch) {
    collector.trackFile(teeMatch[1]);
    return;
  }
  const mvCpMatch = cmd.match(/^(mv|cp)\s+.*\s+['"]?([^\s;|&'"]+)$/);
  if (mvCpMatch) {
    collector.trackFile(mvCpMatch[2]);
  }
}

/**
 * Extract tool usage summaries and files modified using shared SummaryCollector
 */
function extractToolData(
  messages: CodexMessage[],
  config?: VerbosityConfig,
): { summaries: ToolUsageSummary[]; filesModified: string[] } {
  const collector = new SummaryCollector(config);
  const outputsById = new Map<string, string>();

  // First pass: collect function_call_output and custom_tool_call_output by call_id
  for (const msg of messages) {
    if (msg.type !== 'response_item') continue;
    const payload = msg.payload;
    if (
      (payload?.type === 'function_call_output' || payload?.type === 'custom_tool_call_output') &&
      payload.call_id &&
      payload.output
    ) {
      outputsById.set(
        payload.call_id,
        typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output),
      );
    }
  }

  // Second pass: extract tool calls
  for (const msg of messages) {
    if (msg.type === 'response_item') {
      const payload = msg.payload;
      if (!payload) continue;

      // function_call
      if (payload.type === 'function_call' && payload.arguments) {
        try {
          const args = JSON.parse(payload.arguments) as Record<string, unknown>;
          const rawName = payload.name || '';
          const namespace = typeof payload.namespace === 'string' ? payload.namespace : '';
          const name = namespace && !rawName.startsWith(namespace) ? `${namespace}${rawName}` : rawName;
          const output = payload.call_id ? outputsById.get(payload.call_id) : undefined;

          if (name === 'exec_command' || name === 'shell_command') {
            const cmd = String(args.cmd || args.command || '');
            if (!cmd) continue;
            const baseCmd = cmd.trim().split(/\s+/)[0];
            const category = COMMON_SHELL_TOOLS.has(baseCmd) ? baseCmd : 'shell';
            const exitCode = extractExitCode(output);
            const errored = exitCode !== undefined && exitCode !== 0;
            const stdoutTail = output ? extractStdoutTail(output, 5) : undefined;
            collector.add(category, shellSummary(cmd, output), {
              data: {
                category: 'shell',
                command: cmd,
                ...(exitCode !== undefined ? { exitCode } : {}),
                ...(stdoutTail ? { stdoutTail } : {}),
                ...(errored ? { errored } : {}),
              },
              isError: errored,
            });
            trackShellFileWrites(cmd, collector);
          } else if (name === 'write_stdin') {
            const stdin = String(args.chars ?? args.input ?? args.data ?? '');
            collector.add('write_stdin', `stdin: "${truncate(stdin, 60)}"`);
          } else if (isCodexEditTool(name)) {
            const filePath = String(args.path ?? args.file_path ?? '');
            const displayPath = filePath || '(unknown)';
            const codeEdit = typeof args.code_edit === 'string' ? args.code_edit : undefined;
            collector.add(name, withResult(fileSummary('edit', displayPath), output), {
              data: {
                category: 'edit',
                filePath: displayPath,
                ...(codeEdit ? { diff: codeEdit } : {}),
              },
              ...(filePath ? { filePath, isWrite: true } : {}),
            });
          } else if (['read_mcp_resource', 'list_mcp_resources', 'list_mcp_resource_templates'].includes(name)) {
            collector.add(
              'mcp-resource',
              `${name}: ${truncate(String(args.uri || args.server_label || '(all)'), 60)}`,
              {
                data: { category: 'mcp', toolName: name, params: String(args.uri || args.server_label || '') },
              },
            );
          } else if (name === 'request_user_input') {
            const question = truncate(String(args.prompt || args.message || ''), 80);
            collector.add('user-input', `ask: "${question}"`, {
              data: { category: 'ask', question },
            });
          } else if (name === 'update_plan') {
            collector.add('plan', `plan: "${truncate(String(args.explanation || ''), 60)}"`);
          } else if (name === 'view_image') {
            collector.add('view_image', `image: ${truncate(String(args.path || args.url || ''), 60)}`);
          } else if (name.startsWith('mcp__') || name.includes('-')) {
            const params = JSON.stringify(args).slice(0, 100);
            collector.add(name, mcpSummary(name, params, output), {
              data: {
                category: 'mcp',
                toolName: name,
                params,
                ...(output ? { result: output.slice(0, 100) } : {}),
              },
            });
          } else {
            collector.add(name, withResult(`${name}(${JSON.stringify(args).slice(0, 80)})`, output), {
              data: {
                category: 'mcp',
                toolName: name,
                params: JSON.stringify(args).slice(0, 100),
                ...(output ? { result: output.slice(0, 100) } : {}),
              },
            });
          }
        } catch (err) {
          logger.debug('codex: skipping unparseable tool arguments', err);
        }
      }

      // custom_tool_call (e.g. apply_patch)
      if (payload.type === 'custom_tool_call' && payload.name) {
        const name = payload.name;
        const input = payload.input || '';
        if (name === 'apply_patch') {
          const fileMatches = input.match(/\*\*\* (?:Add|Update|Delete) File: (.+)/g) || [];
          const files = fileMatches.map((m: string) => m.replace(/^\*\*\* (?:Add|Update|Delete) File: /, ''));
          const fileList = files.length > 0 ? files.slice(0, 3).join(', ') : '(patch)';
          // Capture the patch content as diff (Codex patches are in unified diff-like format)
          const diff = input.length > 0 ? input : undefined;
          const diffStats = diff ? countDiffStats(diff) : undefined;
          collector.add('apply_patch', `patch: ${truncate(fileList, 70)}`, {
            data: {
              category: 'edit',
              filePath: files[0] || '(multiple)',
              ...(diff ? { diff } : {}),
              ...(diffStats ? { diffStats } : {}),
            },
            filePath: files[0],
            isWrite: true,
          });
          for (const f of files) collector.trackFile(f);
        } else {
          collector.add(name, `${name}: ${truncate(input, 80)}`);
        }
      }

      // web_search_call
      if (payload.type === 'web_search_call') {
        const query = String(payload.action?.query || payload.action?.queries?.[0] || '');
        collector.add('web_search', searchSummary(query), {
          data: { category: 'search', query },
        });
      }
    }
  }

  return { summaries: collector.getSummaries(), filesModified: collector.getFilesModified() };
}

/**
 * Extract session notes from reasoning events, model, and token usage
 */
function extractCodexCompactedText(payload: { message?: string } | undefined): string {
  if (!payload) return '';
  if (typeof payload.message === 'string' && payload.message.trim()) return payload.message;
  return '';
}

function extractSessionNotes(messages: CodexMessage[]): SessionNotes {
  const notes: SessionNotes = {};
  const reasoning: string[] = [];

  const readTokenUsage = (
    raw: unknown,
  ): { input: number; output: number; cached: number; reasoning?: number } | null => {
    if (!raw || typeof raw !== 'object') return null;
    const usage = raw as Record<string, unknown>;
    const input = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
    const output = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
    const cached = typeof usage.cached_input_tokens === 'number' ? usage.cached_input_tokens : 0;
    const reasoningTokens =
      typeof usage.reasoning_output_tokens === 'number' ? usage.reasoning_output_tokens : undefined;
    return { input, output, cached, ...(reasoningTokens !== undefined ? { reasoning: reasoningTokens } : {}) };
  };

  for (const msg of messages) {
    if (msg.type === 'session_meta') {
      const payload = msg.payload as Record<string, unknown> | undefined;
      const git = payload?.git && typeof payload.git === 'object' ? (payload.git as Record<string, unknown>) : {};
      notes.sourceMetadata = {
        ...(notes.sourceMetadata ?? {}),
        ...(typeof payload?.id === 'string' ? { sessionId: payload.id } : {}),
        ...(typeof payload?.timestamp === 'string' ? { sessionTimestamp: payload.timestamp } : {}),
        ...(typeof msg.timestamp === 'string' ? { rolloutTimestamp: msg.timestamp } : {}),
        ...(typeof payload?.source === 'string' ? { source: payload.source } : {}),
        ...(typeof payload?.originator === 'string' ? { originator: payload.originator } : {}),
        ...(typeof payload?.cli_version === 'string' ? { cliVersion: payload.cli_version } : {}),
        ...(typeof payload?.model_provider === 'string' ? { modelProvider: payload.model_provider } : {}),
        ...(typeof git.commit_hash === 'string'
          ? { gitSha: git.commit_hash }
          : typeof git.sha === 'string'
            ? { gitSha: git.sha }
            : {}),
      };
      continue;
    }

    // Model from turn_context
    if (msg.type === 'turn_context') {
      if (msg.payload?.model && !notes.model) notes.model = msg.payload.model;
    }

    if (msg.type === 'compacted') {
      const summary = extractCodexCompactedText(msg.payload);
      if (summary) notes.compactSummary = truncate(summary, 500);
      continue;
    }

    if (msg.type !== 'event_msg') continue;
    const payload = msg.payload;
    if (!payload) continue;

    if (
      payload.type === 'task_started' ||
      payload.type === 'task_complete' ||
      payload.type === 'turn_aborted' ||
      payload.type === 'turn_completed'
    ) {
      if (!notes.lifecycle) notes.lifecycle = [];
      notes.lifecycle.push({
        type: payload.type,
        timestamp: msg.timestamp,
        message: payload.message,
        metadata: extractCodexLifecycleMetadata(payload),
      });
      continue;
    }

    if (payload.type === 'agent_reasoning' && reasoning.length < 5) {
      const text = payload.message || '';
      if (text.length > 20) {
        const firstLine = text.split(/[.\n]/)[0]?.trim();
        if (firstLine) reasoning.push(truncate(firstLine, 200));
      }
    }

    // Token usage (take last value — cumulative)
    if (payload.type === 'token_count') {
      const payloadRecord = payload as Record<string, unknown>;
      const info = payloadRecord.info as Record<string, unknown> | undefined;
      const usage =
        readTokenUsage(info?.total_token_usage) ?? readTokenUsage(info?.last_token_usage) ?? readTokenUsage(payload);

      if (usage) {
        notes.tokenUsage = { input: usage.input, output: usage.output };
        if (usage.cached > 0) {
          notes.cacheTokens = { creation: 0, read: usage.cached };
        }
        if (typeof usage.reasoning === 'number' && usage.reasoning > 0) {
          notes.thinkingTokens = usage.reasoning;
        }
      }
    }
  }

  if (reasoning.length > 0) notes.reasoning = reasoning;
  return notes;
}

/**
 * Extract context from a Codex session for cross-tool continuation
 */
export async function extractCodexContext(session: UnifiedSession, config?: VerbosityConfig): Promise<SessionContext> {
  const resolvedConfig = config ?? getPreset('standard');
  const messages = await readAllMessages(session.originalPath);

  const { summaries: toolSummaries, filesModified } = extractToolData(messages, resolvedConfig);
  const sessionNotes = extractSessionNotes(messages);
  const pendingTasks: string[] = [];

  // Codex sessions contain both response_item and event_msg for the same conversation turns.
  // Collect from both sources separately to avoid duplicates, then merge preferring response_item.
  const eventMsgEntries: ConversationMessage[] = [];
  const responseItemEntries: ConversationMessage[] = [];
  const lifecycleEvents: SessionEvent[] = [];
  let lifecycleSequence = 0;

  for (const msg of messages) {
    if (msg.type === 'event_msg' && msg.payload) {
      const payload = msg.payload;
      if (
        payload.type === 'task_started' ||
        payload.type === 'task_complete' ||
        payload.type === 'turn_aborted' ||
        payload.type === 'turn_completed'
      ) {
        lifecycleEvents.push({
          kind: 'lifecycle',
          sequence: lifecycleSequence++,
          timestamp: parseValidDate(msg.timestamp),
          status: payload.type,
          content: payload.message,
          metadata: extractCodexLifecycleMetadata(payload),
        });
      }
    }

    if (msg.type === 'event_msg') {
      const payload = msg.payload;
      if (payload?.type === 'user_message') {
        const content = payload.message || msg.message || '';
        if (content) {
          eventMsgEntries.push({ role: 'user', content, timestamp: new Date(msg.timestamp) });
        }
      } else if (payload?.type === 'agent_message' || payload?.type === 'assistant_message') {
        const content = payload?.message || '';
        if (content) {
          eventMsgEntries.push({ role: 'assistant', content, timestamp: new Date(msg.timestamp) });
        }
      }
    } else if (msg.type === 'response_item') {
      const payload = msg.payload;
      if (payload?.role === 'user' && payload.type === 'message') {
        const contentParts = payload.content || [];
        const text = contentParts
          .filter((c) => c.type === 'input_text' && c.text)
          .map((c) => c.text)
          .join('\n');
        // Skip system-injected content (AGENTS.md instructions, environment_context, permissions)
        if (
          text &&
          !text.startsWith('<environment_context>') &&
          !text.startsWith('<permissions') &&
          !text.startsWith('# AGENTS.md')
        ) {
          responseItemEntries.push({ role: 'user', content: text, timestamp: new Date(msg.timestamp) });
        }
      } else if (payload?.role === 'assistant' && payload.type === 'message') {
        const contentParts = payload.content || [];
        const text = contentParts
          .filter((c) => (c.type === 'output_text' || c.type === 'text') && c.text)
          .map((c) => c.text)
          .join('\n');
        if (text) {
          responseItemEntries.push({ role: 'assistant', content: text, timestamp: new Date(msg.timestamp) });
        }
      }
      // Skip payload.type === 'reasoning' (chain-of-thought, not a message)
      // Skip payload.role === 'developer' (system instructions)
    }
  }

  // Prefer response_item entries (newer, richer format) when available; fall back to event_msg
  const hasResponseItems =
    responseItemEntries.some((m) => m.role === 'user') || responseItemEntries.some((m) => m.role === 'assistant');
  const allMessages = hasResponseItems ? responseItemEntries : eventMsgEntries;

  // Build a balanced tail: keep the last N messages but ensure user messages aren't lost.
  // Codex sessions can have many consecutive assistant messages (status updates, subagent reports).
  let trimmed: ConversationMessage[];
  const tail = allMessages.slice(-resolvedConfig.recentMessages);
  const hasUser = tail.some((m) => m.role === 'user');
  if (hasUser || allMessages.length <= resolvedConfig.recentMessages) {
    trimmed = tail;
  } else {
    // Include the last user message + everything after it, capped at recentMessages
    let lastUserIdx = -1;
    for (let i = allMessages.length - 1; i >= 0; i--) {
      if (allMessages[i].role === 'user') {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx >= 0) {
      trimmed = allMessages.slice(lastUserIdx, lastUserIdx + resolvedConfig.recentMessages);
    } else {
      trimmed = tail;
    }
  }

  // Build the timeline from the trimmed message set to reduce the chance that
  // older user turns are displaced before rendering. The final recent-activity
  // window is still sliced by event count, so a lifecycle-heavy tail can still
  // push the last user turn out of view.
  const timeline = buildCodexTimeline(trimmed, lifecycleEvents);

  // Generate markdown for injection
  const markdown = generateHandoffMarkdown(
    session,
    trimmed,
    filesModified,
    pendingTasks,
    toolSummaries,
    sessionNotes,
    resolvedConfig,
    'inline',
    timeline,
  );

  return {
    session,
    recentMessages: trimmed,
    filesModified,
    pendingTasks,
    toolSummaries,
    sessionNotes,
    timeline,
    markdown,
  };
}

// generateHandoffMarkdown is imported from ../utils/markdown.js

function parseValidDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

async function extractLastCodexTimestamp(filePath: string): Promise<Date | undefined> {
  let lastTimestamp: Date | undefined;
  await scanJsonlFile(
    filePath,
    (parsed) => {
      const timestamp = parseValidDate((parsed as { timestamp?: string }).timestamp);
      if (timestamp) lastTimestamp = timestamp;
      return 'continue';
    },
    { maxBytes: MAX_METADATA_SCAN_BYTES },
  );
  return lastTimestamp;
}

function extractCodexLifecycleMetadata(payload: Record<string, unknown>): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const key of [
    'turn_id',
    'model_context_window',
    'reason',
    'collaboration_mode_kind',
    'started_at',
    'completed_at',
    'duration_ms',
  ]) {
    const value = payload[key];
    if (value !== undefined) metadata[key] = value;
  }
  return metadata;
}

function getFiniteTimestampMs(d?: Date): number | undefined {
  if (!d) return undefined;
  const ms = d.getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

const TIMELINE_KIND_ORDER: Record<string, number> = {
  message: 0,
  lifecycle: 1,
  reasoning: 2,
  tool_call: 3,
  tool_result: 4,
  metadata: 5,
  warning: 6,
};

function buildCodexTimeline(messages: ConversationMessage[], lifecycleEvents: SessionEvent[]): SessionEvent[] {
  const messageEvents: SessionEvent[] = messages.map(
    (message): SessionEvent => ({
      kind: 'message',
      sequence: 0, // assigned after merge
      role: message.role,
      content: message.content,
      // Drop non-finite (e.g. Invalid Date) so the comparator stays stable
      // and downstream toISOString() never throws.
      ...(getFiniteTimestampMs(message.timestamp) !== undefined ? { timestamp: message.timestamp } : {}),
    }),
  );
  const lifecycleSanitized = lifecycleEvents.map((event) =>
    getFiniteTimestampMs(event.timestamp) !== undefined ? event : { ...event, timestamp: undefined },
  );

  const indexed = [...messageEvents, ...lifecycleSanitized].map((event, originalIndex) => ({
    event,
    timestampMs: getFiniteTimestampMs(event.timestamp) ?? 0,
    kindOrder: TIMELINE_KIND_ORDER[event.kind] ?? 99,
    originalIndex,
  }));

  indexed.sort((a, b) => {
    if (a.timestampMs !== b.timestampMs) return a.timestampMs - b.timestampMs;
    if (a.kindOrder !== b.kindOrder) return a.kindOrder - b.kindOrder;
    return a.originalIndex - b.originalIndex;
  });

  // Assign sequence in final chronological order so windowing in markdown.ts is correct.
  return indexed.map(({ event }, index) => {
    event.sequence = index;
    return event;
  });
}

// ── Codex handoff-session forging ────────────────────────────────────────────
// Full-auto handoff into codex CLI: instead of injecting the handoff document
// as the opening prompt (lossy — a machine-written summary instead of the real
// conversation), forge a native rollout file carrying the source conversation
// and resume it. Verified against codex-cli 0.153.4: `codex resume <uuid>`
// resolves sessions by scanning sessions/YYYY/MM/DD/rollout-*.jsonl, and a
// rollout containing just session_meta + response_item message lines resumes
// with full context (the TUI then continues the conversation natively).

export interface ForgedCodexSession {
  chatId: string;
  taskName: string;
  /** Conversation messages written into the forged rollout */
  prepopulated: number;
  /** Absolute path of the written rollout file */
  rolloutPath: string;
}

/** Build the rollout filename for a forged session (mirrors codex's own
 *  naming: rollout-<ISO-timestamp-with-dashes>-<uuid>.jsonl). Exported for
 *  tests. */
export function codexRolloutFileName(isoTimestamp: string, sessionId: string): string {
  return `rollout-${isoTimestamp.replace(/[:.]/g, '-').slice(0, 19)}-${sessionId}.jsonl`;
}

/**
 * Convert unified conversation messages into codex rollout response_item
 * message lines. Tool calls and thinking have no plaintext representation in
 * the rollout format (reasoning is encrypted_content), so only the
 * conversation text carries over. Exported for tests.
 */
export function conversationToCodexItems(
  messages: ConversationMessage[],
): Array<Record<string, unknown>> {
  return messages
    .filter((m) => m.role !== 'system' && m.content.trim())
    .map((m) => ({
      type: 'response_item',
      payload: {
        type: 'message',
        role: m.role === 'user' ? 'user' : 'assistant',
        content: [
          { type: m.role === 'user' ? 'input_text' : 'output_text', text: m.content },
        ],
      },
    }));
}

/** Random UUIDv7 (time-ordered, matching codex's native turn/item ids). */
function uuidv7(): string {
  const ts = Date.now();
  const bytes = crypto.randomBytes(16);
  bytes[0] = (ts / 2 ** 40) & 0xff;
  bytes[1] = (ts / 2 ** 32) & 0xff;
  bytes[2] = (ts / 2 ** 24) & 0xff;
  bytes[3] = (ts / 2 ** 16) & 0xff;
  bytes[4] = (ts / 2 ** 8) & 0xff;
  bytes[5] = ts & 0xff;
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Most recent real rollout's session_meta payload AND a turn_context payload
 *  as templates for forged sessions (keeps base_instructions/model_provider
 *  and sandbox/approval policy fields native to the installed codex version).
 *  Returns null when no rollout exists. */
function latestCodexRolloutTemplates(): {
  meta: Record<string, unknown>;
  turnContext: Record<string, unknown>;
} | null {
  try {
    const files = findFiles(CODEX_SESSIONS_DIR, {
      match: (entry) => entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl'),
    }).sort();
    for (let i = files.length - 1; i >= 0; i--) {
      const head = scanRolloutHead(files[i], 400);
      const meta = head.find((o) => o.type === 'session_meta');
      const turnContext = head.find((o) => o.type === 'turn_context');
      if (
        meta?.payload &&
        typeof meta.payload === 'object' &&
        turnContext?.payload &&
        typeof turnContext.payload === 'object'
      ) {
        return {
          meta: meta.payload as Record<string, unknown>,
          turnContext: turnContext.payload as Record<string, unknown>,
        };
      }
    }
  } catch (err) {
    logger.debug('codex: rollout template lookup failed', err);
  }
  return null;
}

/** Read the first `maxLines` JSONL lines of a rollout (best-effort). */
function scanRolloutHead(filePath: string, maxLines: number): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    for (const line of raw.split('\n')) {
      if (out.length >= maxLines) break;
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        /* skip malformed lines */
      }
    }
  } catch {
    /* unreadable file */
  }
  return out;
}

/** Serialized rollout lines for a forged codex session: session_meta plus one
 *  native turn structure per user message. Each message is written TWICE by
 *  design — a `response_item` message line (what `codex resume` replays as
 * agent context) paired with an `event_msg item_completed` line (what the
 * Codex desktop app's history projector renders as UI turns; UserMessage
 * items use lowercase `text` blocks + uuidv7 ids, AgentMessage items use
 * capitalized `Text` blocks + `msg_…` ids — matching codex's own events).
 * Exported for tests. */
export function forgeCodexRolloutLines(
  messages: ConversationMessage[],
  sessionId: string,
  cwd: string,
  iso: string,
  metaTemplate: Record<string, unknown>,
  turnContextTemplate: Record<string, unknown>,
): { lines: string[]; turnCount: number; messageCount: number } {
  const out: string[] = [
    JSON.stringify({
      timestamp: iso,
      ordinal: 0,
      type: 'session_meta',
      payload: {
        ...metaTemplate,
        session_id: sessionId,
        id: sessionId,
        timestamp: iso,
        cwd,
        originator: 'codex-cli',
        source: 'cli',
        thread_source: 'user',
        // MUST match the threads registry row (registerCodexThread forces
        // 'paginated' too). Mismatched modes (threads legacy + meta paginated)
        // make the desktop app-server resume fail with "list_turns is not
        // supported yet" (-32601); consistent LEGACY modes resume fine but the
        // desktop UI then skips history loading entirely (no thread/turns/list
        // call — history stays blank). PAGINATED on both sides is the only
        // fully working shape: resume succeeds AND the UI hydrates history
        // from the forged rollout via thread/turns/list (verified against the
        // desktop app bundled with codex-cli 0.153.4).
        history_mode: 'paginated',
      },
    }),
  ];
  let ordinal = 0;
  const push = (record: Record<string, unknown>): void => {
    ordinal += 1;
    out.push(JSON.stringify({ timestamp: iso, ordinal, ...record }));
  };

  let currentTurn: { turnId: string; texts: Array<[string, string]> } | null = null;
  let turnCount = 0;
  let messageCount = 0;

  const flushTurn = (): void => {
    if (!currentTurn) return;
    push({
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: currentTurn.turnId },
    });
    currentTurn = null;
  };

  for (const message of conversationToCodexItems(messages)) {
    const payload = message.payload as {
      role: 'user' | 'assistant';
      content: Array<{ type: string; text: string }>;
    };
    const isUser = payload.role === 'user';
    const text = payload.content[0]?.text ?? '';

    if (isUser) {
      flushTurn();
      const turnId = uuidv7();
      turnCount += 1;
      push({ type: 'event_msg', payload: { type: 'task_started' } });
      push({
        type: 'turn_context',
        payload: {
          ...turnContextTemplate,
          turn_id: turnId,
          root_turn_id: turnId,
          cwd,
          workspace_roots: [cwd],
        },
      });
      currentTurn = { turnId, texts: [] };
    }
    if (!currentTurn) {
      // The recentMessages window can start mid-conversation with trailing
      // assistant replies (their user turn fell outside the window) — fold
      // them into a synthetic opening turn instead of dropping them.
      const turnId = uuidv7();
      turnCount += 1;
      push({ type: 'event_msg', payload: { type: 'task_started' } });
      push({
        type: 'turn_context',
        payload: {
          ...turnContextTemplate,
          turn_id: turnId,
          root_turn_id: turnId,
          cwd,
          workspace_roots: [cwd],
        },
      });
      currentTurn = { turnId, texts: [] };
    }

    const itemId = isUser ? uuidv7() : `msg_${crypto.randomBytes(24).toString('hex')}`;
    push({
      type: 'response_item',
      payload: {
        type: 'message',
        id: `msg_${crypto.randomUUID()}`,
        role: payload.role,
        content: [{ type: isUser ? 'input_text' : 'output_text', text }],
      },
    });
    push({
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: sessionId,
        turn_id: currentTurn.turnId,
        item: {
          type: isUser ? 'UserMessage' : 'AgentMessage',
          id: itemId,
          content: [{ type: isUser ? 'text' : 'Text', text }],
        },
      },
    });
    messageCount += 1;
  }
  flushTurn();

  return { lines: out, turnCount, messageCount };
}

/**
 * Create a native codex rollout carrying the source conversation so the user
 * resumes it losslessly (`codex resume <chatId>` shows the conversation in the
 * TUI context, the desktop app renders it as native turns). The conversation
 * comes from the unified recentMessages (any parser); tool calls and thinking
 * do not survive the format boundary, only the conversation text. Returns
 * null when no messages are available or no template rollout exists to copy
 * session_meta/turn_context from — callers fall back to the prompt-injection
 * handoff.
 */
export function forgeCodexHandoffSession(
  session: UnifiedSession,
  _handoffPath: string,
  recentMessages: ConversationMessage[] = [],
): ForgedCodexSession | null {
  if (conversationToCodexItems(recentMessages).length === 0) return null;

  const templates = latestCodexRolloutTemplates();
  if (!templates) {
    logger.debug('codex: forge skipped — no template rollout found');
    return null;
  }

  const sessionId = crypto.randomUUID();
  const iso = new Date().toISOString();
  const cwd = session.cwd || process.cwd();

  const { lines, messageCount } = forgeCodexRolloutLines(
    recentMessages,
    sessionId,
    cwd,
    iso,
    templates.meta,
    templates.turnContext,
  );

  // Rollouts live under sessions/YYYY/MM/DD/ by session start date; resume
  // scans the tree, so today's directory always resolves.
  const day = iso.slice(0, 10);
  const dir = path.join(CODEX_SESSIONS_DIR, ...day.split('-'));
  const rolloutPath = path.join(dir, codexRolloutFileName(iso, sessionId));
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(rolloutPath, `${lines.join('\n')}\n`);
  } catch (err) {
    logger.debug('codex: forge rollout write failed', err);
    return null;
  }

  // Unified continuation title: 「续」+ source title (native registry title >
  // summary > first user prompt).
  const taskName = continuedSessionTitle(session, recentMessages);
  return {
    chatId: sessionId,
    taskName,
    prepopulated: messageCount,
    rolloutPath,
  };
}

// ── Codex desktop (ChatGPT.app) handoff forging ──────────────────────────────
// The Codex desktop app shares ~/.codex with the CLI: its app-server keeps a
// `threads` registry (state_5.sqlite) whose rollout_path points into
// sessions/, and it backfills new rollout files automatically while running.
// The GUI forge therefore reuses the CLI rollout forge and additionally
// inserts a threads row (template-copied from the newest native row so the
// many NOT NULL policy fields stay valid), so the forged session shows up in
// the desktop app's list whether or not the app is running.

interface SqliteStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): unknown;
}
interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  close(): void;
}

const CODEX_GUI_APP_NAME = 'ChatGPT';

function codexStateDbPath(): string {
  return path.join(CODEX_HOME_DIR, 'state_5.sqlite');
}

/** Insert/refresh a threads registry row for the forged rollout, template-
 *  copied from the newest native REGULAR-USER row (policy fields stay valid).
 *  Returns false when the registry is unavailable — the rollout alone still
 *  works when the app is running (live backfill picks it up). */
function registerCodexThread(
  sessionId: string,
  rolloutPath: string,
  cwd: string,
  title: string,
  firstUserMessage: string,
): boolean {
  try {
    // node:sqlite is loaded lazily so continues keeps working without it
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(codexStateDbPath(), { open: true, timeout: 15_000 }) as SqliteDb;
    try {
      // Template MUST be a regular user thread. Subagent/guardian rows carry
      // special config (model codex-auto-review, thread_source guardian_review,
      // …) whose resume path calls unimplemented turn APIs — a forge copied
      // from a guardian row failed in the desktop app with
      // "list_turns is not supported yet" (app-server error -32601 on
      // thread/resume; verified against the desktop app bundled with
      // codex-cli 0.153.4).
      const template = db
        .prepare("SELECT * FROM threads WHERE thread_source = 'user' ORDER BY updated_at DESC LIMIT 1")
        .get() as Record<string, unknown> | undefined;
      if (!template) return false;

      const nowSec = Math.floor(Date.now() / 1000);
      const nowMs = nowSec * 1000;
      const row: Record<string, unknown> = { ...template };
      row.id = sessionId;
      row.rollout_path = rolloutPath;
      row.created_at = nowSec;
      row.updated_at = nowSec;
      row.created_at_ms = nowMs;
      row.updated_at_ms = nowMs;
      row.recency_at = nowSec;
      row.recency_at_ms = nowMs;
      row.cwd = cwd;
      row.title = title;
      row.first_user_message = firstUserMessage;
      row.preview = firstUserMessage.slice(0, 120);
      row.source = 'cli';
      row.thread_source = 'user';
      // Forged rollouts carry history_mode 'paginated' in their session_meta
      // (see forgeCodexRolloutLines) — the threads row MUST match: mismatched
      // modes break desktop resume (list_turns -32601), consistent legacy
      // resumes but the UI never loads history (skips thread/turns/list).
      row.history_mode = 'paginated';
      row.tokens_used = 0;
      row.has_user_event = 1;
      row.archived = 0;
      row.archived_at = null;
      row.is_pinned = 0;

      const cols = Object.keys(row);
      db.prepare(
        `INSERT OR REPLACE INTO threads (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      ).run(...cols.map((c) => row[c]));
      return true;
    } finally {
      db.close();
    }
  } catch (err) {
    logger.debug('codex: threads registry insert skipped', err);
    return false;
  }
}

export interface ForgedCodexGuiSession extends ForgedCodexSession {
  appWasRunning: boolean;
  /** True when the running app was refreshed with a new window (its session
   *  list re-queries on window creation) — the app itself never restarts. */
  refreshed: boolean;
}

/**
 * GUI counterpart of the codex forge for the Codex desktop app (inside
 * ChatGPT.app): forge the rollout, register a threads row, and bring the app
 * to the foreground. Requires the desktop app to be installed. Returns null
 * to fall back to the clipboard handoff.
 */
export function forgeCodexGuiHandoffSession(
  session: UnifiedSession,
  handoffPath: string,
  recentMessages: ConversationMessage[] = [],
): ForgedCodexGuiSession | null {
  if (!codexDesktopInstalled()) return null;

  // Reuse the CLI forge for the rollout itself; its chatId/taskName flow on.
  const cli = forgeCodexHandoffSession(session, handoffPath, recentMessages);
  if (!cli) return null;

  // The desktop list renders first_user_message/preview as the row label,
  // and the recentMessages window starts mid-conversation for long sources
  // (its first user message is an arbitrary line from the middle) — use the
  // labeled task name so the forged session is recognizable in the list.
  registerCodexThread(cli.chatId, cli.rolloutPath, session.cwd || process.cwd(), cli.taskName, cli.taskName);

  const appWasRunning = isCodexDesktopRunning();
  launchGuiApp(CODEX_GUI_APP_NAME);
  // The running app's session list only re-queries on window creation (no
  // live refresh, no menu Reload) — open a fresh window via the File → New
  // Window menu item so the forged session shows up without a restart.
  // Verified against the desktop app bundled with codex-cli 0.153.4. Windows
  // has no scripted menu click — refreshed=false prints the manual hint.
  const refreshed = appWasRunning ? (process.platform === 'darwin' ? openCodexNewWindow() : false) : true;

  return { ...cli, appWasRunning, refreshed };
}

/** True when the Codex desktop app is installed: ChatGPT.app bundle probe on
 *  macOS; the shared ~/.codex state DB existing (created by the desktop
 *  app-server) on Windows. */
export function codexDesktopInstalled(): boolean {
  if (process.platform === 'darwin') {
    return (
      fs.existsSync('/Applications/ChatGPT.app') ||
      fs.existsSync(path.join(homeDir(), 'Applications', 'ChatGPT.app'))
    );
  }
  if (process.platform === 'win32') {
    return fs.existsSync(codexStateDbPath());
  }
  return false;
}

/** Click the app's File → New Window menu item (System Events; needs the
 *  macOS Accessibility permission) so the session list re-queries. The menu
 *  bar item itself is localized (文件/File) — both names and both item labels
 *  are tried. The click is attempted twice: an app activated moments ago
 *  (e.g. by the forge's own `open -a`) may need a moment before its menu bar
 *  accepts clicks. Best effort — returns false when the click cannot be
 *  delivered. */
function openCodexNewWindow(): boolean {
  const script =
    'on run\n' +
    '  tell application "ChatGPT" to activate\n' +
    '  delay 1.0\n' +
    '  tell application "System Events" to tell (first application process whose name is "ChatGPT")\n' +
    '    repeat with menuName in {"文件", "File"}\n' +
    '      repeat with label in {"新建窗口", "New Window"}\n' +
    '        try\n' +
    '          click (menu item label of menu 1 of menu bar item menuName of menu bar 1)\n' +
    '          return true\n' +
    '        end try\n' +
    '      end repeat\n' +
    '    end repeat\n' +
    '  end tell\n' +
    '  return false\n' +
    'end run';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out = spawnSync('osascript', ['-e', script], { encoding: 'utf8', timeout: 15_000 });
      if (out.status === 0 && out.stdout.trim() === 'true') return true;
      logger.debug('codex: new-window click attempt failed', attempt, out.status, out.stderr);
    } catch (err) {
      logger.debug('codex: new-window click attempt errored', attempt, err);
    }
  }
  return false;
}

/** True when the ChatGPT.app Codex desktop process is running. */
function isCodexDesktopRunning(): boolean {
  if (process.platform === 'win32') return isProcessRunning('ChatGPT.exe');
  try {
    const out = spawnSync('pgrep', ['-f', 'ChatGPT.app/Contents/Resources/codex'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    return out.status === 0 && out.stdout.trim().length > 0;
  } catch {
    return false;
  }
}
