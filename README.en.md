# qoder-continues — Qoder-family edition

[English](README.en.md) | [简体中文](README.md)

> **This is a Qoder-family special-adaptation fork of [yigitkonur/cli-continues](https://github.com/yigitkonur/cli-continues).** On top of the upstream any-to-any session handoff, it adds first-class support for the Qoder family — **Qoder** (New Qoder app + legacy IDE + qodercli), **QoderWork** and **Codex** — including full-fidelity *native session forging*: handoffs into these targets arrive as sessions that look natively born there, with complete UI history and uninterrupted agent context, no paste and no context loss.

> You hit the rate limit mid-debug. 30 messages of context — file changes, architecture decisions, half-finished refactors — and now you either wait hours or start fresh in another tool. **`qc` grabs your session from whichever AI coding tool you were using and hands it off to another one.** Conversation history, file changes, working state — all of it comes along.

```bash
npx qoder-continues
```

https://github.com/user-attachments/assets/6945f3a5-bd19-45ab-9702-6df8e165a734


[![npm version](https://img.shields.io/npm/v/qoder-continues.svg)](https://www.npmjs.com/package/qoder-continues)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Supported tools

18 AI coding agents (plus codexcli / qodercli terminal-only targets), any-to-any handoff:

**Claude Code** · **Codex** (desktop / CLI) · **GitHub Copilot CLI** · **Gemini CLI** · **Cursor** · **Amp** · **Cline** · **Roo Code** · **Kilo Code** · **Kiro** · **Crush** · **OpenCode** · **Factory Droid** · **Antigravity** · **Kimi CLI** · **Qwen Code** · **Qoder** · **QoderWork** — plus **codexcli** / **qodercli** as terminal-only handoff targets

That's 380 cross-tool handoff paths. Pick any source, pick any destination — it works.

## Install

No install needed — just run `npx qoder-continues`. Or install globally:

```bash
npm install -g qoder-continues    # gives you `qoder-continues` and `qc`
```

## How it works

1. **Discovery** — scans session directories for all tools
2. **Parsing** — reads each tool's native format (JSONL, JSON, SQLite, YAML — they're all different)
3. **Extraction** — pulls recent messages, file changes, tool activity, AI reasoning
4. **Handoff** — generates a structured context doc and injects it into the target tool; for the Qoder family and Codex, forges a native session instead for lossless continuation

## Two handoff modes

### Mode 1: handoff document (default, all tools)

The source session is extracted into a structured Markdown doc (overview / key decisions / recent conversation / tool activity / pending tasks) and handed to the target agent as its opening prompt. The receiving agent immediately understands what you were doing, what files were touched, what commands ran, and what's left to do.

### Mode 2: native session forging (lossless — Qoder family + Codex)

Forges a session that looks like it always lived in the target's local store — lossless for both agent context and UI history, no pasting required:

| Target | What gets forged | Result |
|:-------|:-----------------|:-------|
| **Qoder** (New Qoder app) | transcript + plaintext SQLite session rows | The continued session appears in the sidebar with full history; the first message continues the source conversation |
| **QoderWork** | chats/sub_chats rows + chain-rebuilt transcript + pre-populated messages | Task appears with complete rendered history (thinking cards included) |
| **Codex** (ChatGPT desktop app) | native event-structured rollout + threads registry entry | Session appears in the list with full turn-by-turn history |
| **codexcli** (terminal TUI) | native event-structured rollout | `codex resume` starts with the complete conversation |

When the source is Qoder / QoderWork (same family), thinking blocks and tool-call structure carry over verbatim; cross-family sources (e.g. Claude → Qoder) convert message by message — far more faithful than a document summary.

## Usage

### Interactive (default)

Just run `qc`. It finds all your sessions, lets you pick one, and asks where to continue:

```
┌  qc — pick up where you left off
│
│  Found 1842 sessions across 18 CLI tools
│    claude: 723  codex: 72  cursor: 68  copilot: 39  ...
│
◆  Select a session
│  [claude]   2026-02-19 05:28  my-project    Debugging SSH tunnel config   84a36c5d
│  [copilot]  2026-02-19 04:41  my-project    Migrate presets from Electron c2f5974c
│  [codex]    2026-02-18 23:12  my-project    Fix OpenCode SQLite parser    a1e90b3f
│  ...
└

◆  Continue in:
│  ○ Gemini   ○ Codex   ○ Amp   ○ Kiro   ...
└
```

When you run from a project directory, sessions from that directory are prioritized.

### Quick resume

Skip the picker entirely — resume the Nth most recent session from a tool:

```bash
qc claude        # latest Claude session
qc codex 3       # 3rd most recent Codex
qc amp           # latest Amp
qc cline         # latest Cline
qc kiro          # latest Kiro
qc crush         # latest Crush
qc kimi          # latest Kimi
qc qwen-code     # latest Qwen Code
qc qoder         # latest Qoder
qc qoderwork     # latest QoderWork
```

Works for all tools. This uses **native resume** — same tool, full history, no context injection.

### Cross-tool handoff

This is the main thing. Start in one tool, finish in another:

```bash
# Hit the Claude rate limit? Hand it off to Gemini:
qc resume abc123 --in gemini

# Hand off to Qoder (forges a native session — lossless):
qc resume abc123 --in qoder

# Hand off to the Codex desktop app (forges rollout + threads — lossless):
qc resume abc123 --in codex

# Or to the codexcli terminal (forges rollout, resumes it):
qc resume abc123 --in codexcli

# Or pass flags through to the destination tool:
qc resume abc123 --in codex --yolo --search --add-dir /tmp

# Or print the exact handoff prompt without launching the target tool:
qc resume abc123 --in codex --debug-prompt
```

`qc` maps common flags (model, sandbox, auto-approve, extra dirs) to the target tool's equivalent. Anything it doesn't recognize gets passed through as-is.

`--debug-prompt` is for handoff inspection and testing. It writes the handoff file as usual, then prints the exact prompt that would be passed to the target agent and exits without launching it.

### Scripting & CI

```bash
qc list                          # table output
qc list --source claude --json   # JSON, filtered
qc list --jsonl -n 10            # JSONL, last 10
qc scan                          # discovery stats
qc scan --rebuild                # force re-index
```

### Inspect (for debugging)

See exactly what gets parsed and what ends up in the handoff:

```bash
qc inspect abc123                              # diagnostic view
qc inspect abc123 --preset full --write-md handoff.md   # dump full markdown
qc inspect abc123 --truncate 50                # compact one-liner view
```

### Dump (bulk export)

Export all sessions to files for backup, analysis, or archival:

```bash
# Export all sessions to markdown (default)
qc dump all ./sessions

# Export specific tool's sessions
qc dump claude ./sessions/claude
qc dump gemini ./sessions/gemini

# Export as JSON instead of markdown
qc dump all ./sessions --json

# Control verbosity with presets
qc dump all ./sessions --preset full

# Limit number of sessions
qc dump all ./sessions --limit 50
```

File naming: `{source}_{id}.md` or `{source}_{id}.json`

## Verbosity control

Not every handoff needs to be a novel. Four presets control how much detail goes in:

| Preset | Messages | Tool samples | Subagent detail | When to use |
|:-------|:---------|:-------------|:----------------|:------------|
| `minimal` | 3 | 0 | None | Quick context, token-constrained targets |
| `standard` | 10 | 5 | 500 chars | Default — good balance |
| `verbose` | 20 | 10 | 2000 chars | Debugging, complex multi-file tasks |
| `full` | 50 | All | Everything | Complete session capture |

```bash
qc resume abc123 --preset full
```

### YAML config

For per-project defaults, drop a `.continues.yml` in your project root:

```yaml
preset: verbose
recentMessages: 15
shell:
  maxSamples: 10
  stdoutLines: 20
```

Resolution order: `--config <path>` → `.continues.yml` in cwd → `~/.continues/config.yml` → `standard` preset. See `.continues.example.yml` for the full reference.

## What gets extracted

Every tool stores sessions differently — different formats, different schemas, different paths. Here's what `qc` reads:

| Tool | Format | Where it lives |
|:-----|:-------|:---------------|
| Claude Code | JSONL | `~/.claude/projects/` |
| Codex | JSONL | `~/.codex/sessions/` |
| Copilot | YAML + JSONL | `~/.copilot/session-state/` |
| Gemini CLI | JSON | `~/.gemini/tmp/*/chats/` |
| OpenCode | SQLite | `~/.local/share/opencode/storage/` |
| Factory Droid | JSONL + JSON | `~/.factory/sessions/` |
| Cursor | JSONL | `~/.cursor/projects/*/agent-transcripts/` |
| Amp | JSON | `~/.local/share/amp/threads/` |
| Kiro | JSON | `~/Library/Application Support/Kiro/workspace-sessions/` |
| Crush | SQLite | `~/.crush/crush.db` |
| Cline | JSON | VS Code `globalStorage/saoudrizwan.claude-dev/tasks/` |
| Roo Code | JSON | VS Code `globalStorage/rooveterinaryinc.roo-cline/tasks/` |
| Kilo Code | JSON | VS Code `globalStorage/kilocode.kilo-code/tasks/` |
| Antigravity | PB + brain artifacts + optional live RPC | `~/.gemini/antigravity/` |
| Kimi CLI | JSONL + JSON | `~/.kimi/sessions/` |
| Qwen Code | JSONL | `~/.qwen/projects/*/chats/` |
| Qoder | JSONL | `~/.qoder/projects/` (IDE, app and CLI layouts) |
| QoderWork | JSONL + JSON | `~/.qoderwork/projects/` |

All reads are **read-only** — `qc` never modifies your session files. Index cached at `~/.continues/sessions.jsonl` (5-min TTL, auto-refresh).

### Tool activity in handoffs

The handoff document includes a **Tool Activity** section so the target agent knows what was *done*, not just what was *said*:

```markdown
## Tool Activity
- **Bash** (×47): `$ npm test → exit 0` · `$ git status → exit 0` · `$ npm run build → exit 1`
- **Edit** (×12): `edit src/auth.ts` · `edit src/api/routes.ts` · `edit tests/auth.test.ts`
- **Grep** (×8): `grep "handleLogin" src/` · `grep "JWT_SECRET"` · `grep "middleware"`

## Session Notes
- **Model**: claude-sonnet-4
- **Tokens**: 45,230 in / 12,847 out
- 💭 Need to handle the edge case where token refresh races with logout
```

This works for all tools — bash commands, file reads/writes/edits, grep/glob, MCP tool calls, thinking blocks, subagent dispatches, token usage, model info. The shared `SummaryCollector` keeps the format consistent regardless of source.

Every handoff also includes the **full file path** of the original session, so the receiving tool can trace back to the raw data if needed.

## Commands reference

| Command | What it does |
|:--------|:-------------|
| `qc` | Interactive TUI picker |
| `qc list` | List sessions (`--source`, `--json`, `--jsonl`, `-n`) |
| `qc resume <id>` | Resume by ID (`--in <tool>`, `--preset`) |
| `qc inspect <id>` | Diagnostic view (`--truncate`, `--write-md`, `--preset`) |
| `qc dump <source\|all> <dir>` | Bulk export sessions (`--json`, `--preset`, `--limit`) |
| `qc scan` | Discovery stats (`--rebuild`) |
| `qc rebuild` | Force-rebuild session index |
| `qc <tool> [n]` | Quick-resume Nth session from any tool |

Global flags: `--config <path>`, `--preset <name>`, `--verbose`, `--debug`

## Community contributions (upstream)

This fork is based on [yigitkonur/cli-continues](https://github.com/yigitkonur/cli-continues) and keeps full compatibility with it; everything upstream — parsers, handoff pipeline, CLI surface — still works as documented below. The Qoder-family additions (Qoder / QoderWork / qodercli adapters, Codex forging, GUI-app handoff targets) live on top of that foundation. The upstream project started as a 7-tool effort and grew fast thanks to contributors:

- **Factory Droid support** — [#1](https://github.com/yigitkonur/cli-continues/pull/1), first community parser
- **Cursor AI support** — [#4](https://github.com/yigitkonur/cli-continues/pull/4) by [@Evrim267](https://github.com/Evrim267), with smart slug-to-path resolution
- **Single-tool error handling** — [#3](https://github.com/yigitkonur/cli-continues/pull/3) by [@barisgirismen](https://github.com/barisgirismen), clear error when only one CLI is installed
- **Env var overrides** — [#14](https://github.com/yigitkonur/cli-continues/pull/14) by [@yutakobayashidev](https://github.com/yutakobayashidev), respects `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME`, `XDG_DATA_HOME`

The latest batch — **Amp, Kiro, Crush, Cline, Roo Code, Kilo Code, Antigravity, Kimi CLI, and Qwen Code** — was added by reverse-engineering [mnemo](https://github.com/Pilan-AI/mnemo)'s Go adapters and adapting the schemas for TypeScript. Along the way we also improved token/cache/model extraction for the existing Claude, Codex, Cursor, and Gemini parsers.

**Bugs fixed in this round:**
- Symlink traversal — `fs.Dirent.isDirectory()` returns `false` for symlinks; fixed with `isSymbolicLink() && statSync()` fallback
- Zero-token display — no longer shows "0 in / 0 out" when a session has no token data
- Key Decisions count — now respects the verbosity config instead of being hardcoded to 5

## Requirements

- **Node.js 22.5+** (uses built-in `node:sqlite` for OpenCode and Crush)
- At least one supported tool installed
- **Platforms**: Windows / macOS / Linux all supported. Handoff documents and CLI resume work identically everywhere; native session forging (Qoder family, Codex) writes identical data on every platform, auto-refreshes the GUI on macOS, and prints a manual-refresh hint on Windows

## Development

```bash
git clone https://github.com/llsgg/qoder-continues.git
cd qoder-continues
pnpm install

pnpm run dev          # run with tsx, no build needed
pnpm run build        # compile TypeScript
pnpm test             # run tests
pnpm run test:watch   # watch mode
```

Adding a new tool? Create a parser in `src/parsers/`, add the tool name to `src/types/tool-names.ts`, register it in `src/parsers/registry.ts`. The registry has a compile-time completeness check — if you add a name but forget the parser, it throws at import.

## License

MIT © [Yigit Konur](https://github.com/yigitkonur)
