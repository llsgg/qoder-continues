import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { VerbosityConfig } from '../config/index.js';
import { getPreset, loadConfig } from '../config/index.js';
import { ToolNotAvailableError, UnknownSourceError } from '../errors.js';
import { logger } from '../logger.js';
import { ALL_TOOLS, adapters } from '../parsers/registry.js';
import type { SessionContext, SessionSource, UnifiedSession } from '../types/index.js';
import {
  type ForwardResolution,
  formatForwardArgs,
  type HandoffForwardingOptions,
  resolveTargetForwarding,
} from './forward-flags.js';
import { extractContext, saveContext } from './index.js';
import { getSourceLabels, safePath } from './markdown.js';
import { IS_WINDOWS, WHICH_CMD } from './platform.js';

export interface HandoffContextOptions {
  preset?: string;
  configPath?: string;
  chain?: boolean;
  debugPrompt?: boolean;
}

export function getToolBinaryCandidates(tool: SessionSource): string[] {
  const adapter = adapters[tool];
  if (!adapter) return [];
  return [adapter.binaryName, ...(adapter.binaryFallbacks ?? [])];
}

/**
 * Resolve mapped + passthrough forward args for cross-tool launches.
 */
export function resolveCrossToolForwarding(
  target: SessionSource,
  options?: HandoffForwardingOptions,
): ForwardResolution {
  const adapter = adapters[target];
  if (!adapter) throw new UnknownSourceError(target);
  return resolveTargetForwarding(target, adapter.mapHandoffFlags, options);
}

function hasConfigOverride(args: string[], key: string): boolean {
  const keyPrefix = `${key}=`;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    if ((token === '-c' || token === '--config') && index + 1 < args.length) {
      const value = args[index + 1]?.trim();
      if (value?.startsWith(keyPrefix)) return true;
      index += 1;
      continue;
    }

    if (token.startsWith('-c=')) {
      if (token.slice(3).trim().startsWith(keyPrefix)) return true;
    }

    if (token.startsWith('--config=')) {
      if (token.slice('--config='.length).trim().startsWith(keyPrefix)) return true;
    }
  }

  return false;
}

export function getDefaultHandoffInitArgs(target: SessionSource, forwardedArgs: string[] = []): string[] {
  if (target !== 'codex') return [];

  const defaults: string[] = [];

  if (!hasConfigOverride(forwardedArgs, 'model_reasoning_effort')) {
    defaults.push('-c', 'model_reasoning_effort="high"');
  }

  if (!hasConfigOverride(forwardedArgs, 'model_reasoning_summary')) {
    defaults.push('-c', 'model_reasoning_summary="detailed"');
  }

  if (!hasConfigOverride(forwardedArgs, 'model_supports_reasoning_summaries')) {
    defaults.push('-c', 'model_supports_reasoning_summaries=true');
  }

  return defaults;
}

function resolveHandoffConfig(options?: HandoffContextOptions): VerbosityConfig {
  const loaded = loadConfig(options?.configPath);

  let config = loaded;
  if (options?.preset) {
    try {
      config = getPreset(options.preset);
    } catch {
      // Keep loaded config when an invalid preset is provided.
    }
  }

  if (options?.chain === false) {
    config = {
      ...config,
      agents: {
        ...config.agents,
        claude: {
          ...config.agents.claude,
          chainCompactedHistory: false,
        },
      },
    };
  }

  return config;
}

/**
 * Resume a session using native CLI commands
 */
export async function nativeResume(session: UnifiedSession): Promise<void> {
  const cwd = session.cwd || process.cwd();
  const adapter = adapters[session.source];
  if (!adapter) throw new UnknownSourceError(session.source);
  // GUI apps manage their own session lists; just launch the app. Adapters
  // whose CLI sessions resume natively (qoder: `qodercli -r <uuid>`) keep that
  // path — the app name is only a pseudo-binary availability marker there,
  // so the real CLI binary is resolved instead.
  if (adapter.guiApp) {
    const args = adapter.nativeResumeArgs(session);
    if (args.length === 0) {
      await openGuiApp(adapter.guiApp.appName);
      return;
    }
    const cliBinary = await resolveCliBinaryName(session.source);
    if (cliBinary) {
      await runCommand(cliBinary, args, cwd);
      return;
    }
    await openGuiApp(adapter.guiApp.appName);
    return;
  }
  const binaryName = await requireToolBinaryName(session.source);
  await runCommand(binaryName, adapter.nativeResumeArgs(session), cwd);
}

/**
 * Resume a session in a different tool (cross-tool)
 */
export async function crossToolResume(
  session: UnifiedSession,
  target: SessionSource,
  mode: 'inline' | 'reference' = 'inline',
  forwarding?: HandoffForwardingOptions,
  contextOptions?: HandoffContextOptions,
): Promise<void> {
  const adapter = adapters[target];
  if (!adapter) throw new UnknownSourceError(target);

  const context = await extractContext(session, resolveHandoffConfig(contextOptions));
  const cwd = session.cwd || process.cwd();

  // Always save handoff file to project directory (for sandboxed tools like Gemini)
  const localPath = path.join(cwd, '.continues-handoff.md');
  let handoffWritten = false;
  try {
    fs.writeFileSync(localPath, context.markdown);
    handoffWritten = true;
  } catch (err) {
    logger.debug('resume: failed to write handoff file', localPath, err);
  }

  // Also save to global directory as backup
  saveContext(context);

  // On Windows the prompt references .continues-handoff.md — the write must succeed
  if (IS_WINDOWS && !handoffWritten) {
    throw new Error(
      `Failed to write handoff file to ${localPath}. Cross-tool resume on Windows requires this file. Check directory permissions.`,
    );
  }

  // Build prompt based on mode
  const prompt = IS_WINDOWS
    ? buildWindowsSafePrompt(session)
    : mode === 'inline'
      ? buildInlinePrompt(context, session)
      : buildReferencePrompt(session);

  if (contextOptions?.debugPrompt) {
    console.log(prompt);
    return;
  }

  // Cross-source fidelity: hand any forge the whole conversation so sources
  // whose transcripts are not in the target's native line shape still get
  // full per-message history instead of a single handoff-blob message. The
  // window cap is lifted — a 50-message slice of a long session both loses
  // the early turns and can start mid-stream with trailing assistant
  // replies, which forges render as one degenerate turn.
  let recentMessages = context.recentMessages;
  if (session.source !== target && adapter.forgeHandoffSession) {
    try {
      const forgeConfig = { ...getPreset('full'), recentMessages: 100_000 };
      recentMessages = (await extractContext(session, forgeConfig)).recentMessages;
    } catch (err) {
      logger.debug('resume: full-preset extraction for forge failed', err);
    }
  }

  // GUI-app target: no CLI process to spawn. Adapters may provide a full-auto
  // forge (native session in the app's local store + agent trigger); when that
  // is unavailable or fails, fall back to clipboard + `open -a`.
  if (adapter.guiApp) {
    if (adapter.forgeHandoffSession) {
      const forged = await adapter.forgeHandoffSession(session, localPath, recentMessages);
      if (forged) {
        console.log();
        console.log(`  Handoff file: ${safePath(localPath)}`);
        console.log(`  ${forged.taskName}`);
        console.log(
          `  ${adapter.guiApp.appName} task ready (id: ${forged.chatId}) — ${forged.prepopulated} history messages restored`,
        );
        if (forged.appWasRunning && forged.refreshed === false) {
          console.log(
            `  ${adapter.guiApp.appName} is running — ${guiRefreshHint(adapter.guiApp.appName)} to see the session in the list.`,
          );
          console.log(
            `  Tip: grant your terminal the macOS Accessibility permission (System Settings → Privacy & Security → Accessibility) and continues refreshes the list for you next time.`,
          );
        } else if (forged.appWasRunning && forged.refreshed === true) {
          console.log(
            `  ${adapter.guiApp.appName} list refreshed (app kept running) — open the task from the list to continue.`,
          );
        } else {
          console.log(`  ${adapter.guiApp.appName} is up — open the task from the list to continue.`);
        }
        return;
      }
    }
    await guiHandoff(session, adapter.guiApp.appName, localPath);
    return;
  }

  const binaryName = await requireToolBinaryName(target);
  const resolved = resolveCrossToolForwarding(target, forwarding);
  const defaultInitArgs = getDefaultHandoffInitArgs(target, resolved.extraArgs);

  // CLI target with a forge adapter: a forged native session beats the
  // prompt injection — resume it losslessly instead of spawning the prompt.
  if (adapter.forgeHandoffSession && session.source !== target) {
    try {
      const forged = await adapter.forgeHandoffSession(session, localPath, recentMessages);
      if (forged?.resumeArgs && forged.resumeArgs.length > 0) {
        console.log();
        console.log(`  Handoff file: ${safePath(localPath)}`);
        console.log(`  ${forged.taskName}`);
        console.log(
          `  ${adapter.label} session forged (id: ${forged.chatId}) — ${forged.prepopulated} history messages restored, resuming...`,
        );
        await runCommand(
          binaryName,
          [...defaultInitArgs, ...resolved.extraArgs, ...forged.resumeArgs],
          cwd,
        );
        return;
      }
    } catch (err) {
      logger.debug('resume: forge handoff failed, falling back to prompt injection', err);
    }
  }

  await runCommand(binaryName, [...defaultInitArgs, ...resolved.extraArgs, ...adapter.crossToolArgs(prompt, cwd)], cwd);
}

/** Per-app manual refresh hint, shown when the automatic refresh (menu click)
 *  could not be delivered. Each app's list only re-queries on its own
 *  trigger — the hint names that trigger. */
function guiRefreshHint(appName: string): string {
  if (appName === 'Qoder') return 'reload its window (menu 显示 → 重新载入 / View → Reload)';
  if (appName === 'ChatGPT') return 'open a new window (menu 文件 → 新建窗口 / File → New Window)';
  return 'open a new window or restart the app';
}

/**
 * Build an inline prompt that embeds the full session context directly.
 * The LLM gets everything upfront — no file reading needed.
 */
function buildInlinePrompt(context: SessionContext, session: UnifiedSession): string {
  const sourceLabel = getSourceLabels()[session.source] || session.source;

  // Simple intro — the handoff markdown already has the full table, conversation, and closing directive
  const sessionFileRef = session.originalPath ? ` (original session: \`${safePath(session.originalPath)}\`)` : '';
  const intro = `I'm continuing a coding session from **${sourceLabel}**${sessionFileRef}. Here's the full context:\n\n---\n\n`;

  return intro + context.markdown;
}

/**
 * Build a compact reference prompt that points to the handoff file.
 * Used when --reference flag is passed (for very large sessions).
 */
function buildReferencePrompt(session: UnifiedSession): string {
  const sourceLabel = getSourceLabels()[session.source] || session.source;

  return [
    `# 🔄 Session Handoff`,
    ``,
    `Picking up a coding session from **${sourceLabel}**. The full context is in \`.continues-handoff.md\`.`,
    ``,
    `| Detail | Value |`,
    `|--------|-------|`,
    `| Previous tool | ${sourceLabel} |`,
    `| Working directory | \`${session.cwd}\` |`,
    session.originalPath ? `| Original session file | \`${safePath(session.originalPath)}\` |` : '',
    `| Context file | \`.continues-handoff.md\` |`,
    session.summary ? `| Last task | ${session.summary.slice(0, 80)} |` : '',
    ``,
    `Read \`.continues-handoff.md\` first, then continue the work.`,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Build a single-line, cmd.exe-safe prompt for Windows cross-tool handoff.
 *
 * On Windows, `spawn()` with `shell: true` passes args through `cmd.exe`,
 * which treats embedded newlines as command separators and splits on shell
 * metacharacters (`|`, `&`, `>`, `<`, `^`, `%`, `!`, backticks, `"`).
 * Additionally, `cmd.exe` has an 8191-character command-line limit.
 *
 * Since `.continues-handoff.md` is already written to the project directory,
 * this prompt simply instructs the target tool to read that file.
 */
export function buildWindowsSafePrompt(session: UnifiedSession): string {
  return `Continuing a coding session from ${session.source}. Read the file .continues-handoff.md in the current directory for full context and continue where it left off.`;
}

/**
 * Resume a session - automatically chooses native or cross-tool
 */
export async function resume(
  session: UnifiedSession,
  target?: SessionSource,
  mode: 'inline' | 'reference' = 'inline',
  forwarding?: HandoffForwardingOptions,
  contextOptions?: HandoffContextOptions,
): Promise<void> {
  const actualTarget = target || session.source;

  if (contextOptions?.debugPrompt && actualTarget === session.source) {
    throw new Error(
      '--debug-prompt requires a cross-tool handoff target. Use --in <tool> different from the source session.',
    );
  }

  if (actualTarget === session.source) {
    // Same tool - use native resume
    await nativeResume(session);
  } else {
    // Different tool - use cross-tool injection
    await crossToolResume(session, actualTarget, mode, forwarding, contextOptions);
  }
}

/**
 * Run a command with proper TTY handling
 */
function runCommand(command: string, args: string[], cwd: string, stdinData?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const stdio: import('node:child_process').StdioOptions = stdinData ? ['pipe', 'inherit', 'inherit'] : 'inherit';

    // On Windows, invoke cmd.exe explicitly to handle .cmd/.bat shims.
    // Args stay in the array — no shell:true (avoids DEP0190), no string
    // concatenation (avoids command-injection risk).
    const child = IS_WINDOWS
      ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/c', command, ...args], { cwd, stdio })
      : spawn(command, args, { cwd, stdio });

    if (stdinData && child.stdin) {
      child.stdin.write(stdinData);
      child.stdin.end();
    }

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command exited with code ${code}`));
      }
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Check if a CLI tool is available by binary name
 */
async function isBinaryAvailable(binaryName: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(WHICH_CMD, [binaryName], { stdio: 'ignore' });
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

/**
 * Resolve the install path of a macOS GUI app, or null on non-darwin /
 * when the app is not installed.
 */
function guiAppPath(appName: string): string | null {
  if (process.platform !== 'darwin') return null;
  const home = process.env.HOME || '';
  const candidates = [
    `/Applications/${appName}.app`,
    ...(home ? [path.join(home, 'Applications', `${appName}.app`)] : []),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Copy text to the macOS clipboard via pbcopy (best effort — resolves even
 * on failure so handoff continues with on-screen instructions only).
 */
function copyToClipboardMac(text: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn('pbcopy', [], { stdio: ['pipe', 'ignore', 'ignore'] });
      child.stdin.on('error', () => resolve(false));
      child.stdin.write(text, () => child.stdin.end());
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

/**
 * Launch a macOS GUI app via `open -a` (detached so continues can exit).
 */
function openGuiApp(appName: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn('open', ['-a', appName], { stdio: 'ignore', detached: true });
      child.on('error', () => resolve(false));
      child.on('spawn', () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

/**
 * GUI-app cross-tool handoff: write the handoff file (already done by the
 * caller), copy a file-reference prompt to the clipboard, launch the app,
 * and print paste instructions.
 */
async function guiHandoff(session: UnifiedSession, appName: string, handoffPath: string): Promise<void> {
  const sourceLabel = getSourceLabels()[session.source] || session.source;
  const prompt = [
    `Continuing a coding session from **${sourceLabel}**. The full context is in the handoff file:`,
    '',
    '```',
    handoffPath,
    '```',
    '',
    'Read that file first (task background, key decisions, recent conversation, file changes), summarize your understanding of the current progress, and then we continue.',
  ].join('\n');

  const copied = await copyToClipboardMac(prompt);
  const launched = await openGuiApp(appName);

  console.log();
  console.log(`  Handoff file: ${safePath(handoffPath)}`);
  if (copied) console.log('  Handoff prompt copied to clipboard');
  if (launched) console.log(`  ${appName} launched`);
  console.log(
    `  Create a new ${appName} session and paste${copied ? ' (Cmd+V)' : ' the prompt above'} to continue.`,
  );
}

export async function resolveToolBinaryName(
  tool: SessionSource,
  isAvailable: (binaryName: string) => Promise<boolean> = isBinaryAvailable,
): Promise<string | null> {
  // GUI-app targets count as available when the macOS app is installed; the
  // app name doubles as the pseudo-binary marker (never exec'd directly —
  // nativeResume/crossToolResume intercept guiApp adapters before spawning).
  const adapter = adapters[tool];
  if (adapter?.guiApp && guiAppPath(adapter.guiApp.appName)) {
    return adapter.guiApp.appName;
  }
  for (const candidate of getToolBinaryCandidates(tool)) {
    if (await isAvailable(candidate)) return candidate;
  }
  return null;
}

async function requireToolBinaryName(tool: SessionSource): Promise<string> {
  const binaryName = await resolveToolBinaryName(tool);
  if (binaryName) return binaryName;

  const adapter = adapters[tool];
  throw new ToolNotAvailableError(adapter?.label ?? tool);
}

/**
 * Resolve the first installed CLI binary for a tool, skipping guiApp
 * pseudo-binary names (e.g. qoder's "Qoder IDE" app marker → qodercli).
 */
async function resolveCliBinaryName(tool: SessionSource): Promise<string | null> {
  for (const candidate of getToolBinaryCandidates(tool)) {
    if (await isBinaryAvailable(candidate)) return candidate;
  }
  return null;
}

/**
 * Get available tools
 */
export async function getAvailableTools(): Promise<SessionSource[]> {
  const checks = await Promise.allSettled(
    ALL_TOOLS.map(async (name) => ({
      name,
      ok: (await resolveToolBinaryName(name)) !== null,
    })),
  );

  return checks
    .filter(
      (r): r is PromiseFulfilledResult<{ name: SessionSource; ok: boolean }> => r.status === 'fulfilled' && r.value.ok,
    )
    .map((r) => r.value.name);
}

/**
 * Get resume command for display purposes
 */
export function getResumeCommand(
  session: UnifiedSession,
  target?: SessionSource,
  forwarding?: HandoffForwardingOptions,
): string {
  const actualTarget = target || session.source;
  const actualAdapter = adapters[actualTarget];
  if (!actualAdapter) throw new UnknownSourceError(actualTarget);

  if (actualTarget === session.source) {
    return actualAdapter.resumeCommandDisplay(session);
  }

  const resolved = resolveCrossToolForwarding(actualTarget, forwarding);
  const defaultInitArgs = getDefaultHandoffInitArgs(actualTarget, resolved.extraArgs);
  const suffixArgs = [...defaultInitArgs, ...resolved.extraArgs];
  const suffix = suffixArgs.length > 0 ? ` ${formatForwardArgs(suffixArgs)}` : '';
  return `qc resume ${session.id} --in ${actualTarget}${suffix}`;
}
