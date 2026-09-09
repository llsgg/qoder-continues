# qoder-continues — Qoder 系特别适配版

[English](README.en.md) | [简体中文](README.md)

> **本项目是基于 [yigitkonur/cli-continues](https://github.com/yigitkonur/cli-continues) 开发的 Qoder 系列特别适配版本。** 在上游任意工具互传能力之上，为 Qoder 家族——**Qoder**（New Qoder app + 老 IDE + qodercli）、**QoderWork** 和 **Codex**——提供一等公民支持，包括全保真的*原生会话伪造*：接续到这些目标时，会话以"本来就在那"的原生形态出现，UI 历史完整、agent 上下文无损，无需粘贴、不丢上下文。

> 调试到一半，额度突然用完了。30 条消息的上下文——文件改动、架构决策、改到一半的重构——你要么干等几个小时，要么换个工具从头再来。**`qc` 把你在任意 AI 编码工具里的会话取出来，交给另一个工具继续。** 对话历史、文件变更、工作状态，全部带走。

```bash
npx qoder-continues
```

[![npm version](https://img.shields.io/npm/v/qoder-continues.svg)](https://www.npmjs.com/package/qoder-continues)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## 支持的工具

18 个 AI 编码 agent（外加 codexcli / qodercli 两个纯终端目标），任意互传：

**Claude Code** · **Codex**（桌面版 / CLI）· **GitHub Copilot CLI** · **Gemini CLI** · **Cursor** · **Amp** · **Cline** · **Roo Code** · **Kilo Code** · **Kiro** · **Crush** · **OpenCode** · **Factory Droid** · **Antigravity** · **Kimi CLI** · **Qwen Code** · **Qoder** · **QoderWork** · 另有 **codexcli** / **qodercli** 作为纯终端接续目标

任选来源、任选目标，共 380 条跨工具接续路径。

## 安装

无需安装，直接 `npx qoder-continues`。或全局安装：

```bash
npm install -g qoder-continues    # 提供 qoder-continues 和 qc 两个命令
```

## 工作原理

1. **发现** — 扫描全部工具的会话目录
2. **解析** — 读取每个工具的原生格式（JSONL、JSON、SQLite、YAML——各家都不一样）
3. **提取** — 抽取最近消息、文件变更、工具调用记录、AI 思考过程
4. **接续** — 生成结构化上下文文档注入目标工具；对 Qoder 系与 Codex 系则直接伪造原生会话，无损接续

## 两种接续模式

### 模式一：交接文档（默认，覆盖全部工具）

把源会话提取为结构化 Markdown（概览 / 关键决策 / 最近对话 / 工具活动 / 待办），作为初始 prompt 交给目标 agent。目标 agent 一上来就知道你做到哪了、动过哪些文件、跑过什么命令、还剩什么没做。

### 模式二：原生会话伪造（无损，Qoder 系 + Codex 系）

在目标工具的本地存储里直接伪造一个"本来就在那"的原生会话——agent 上下文与 UI 历史双无损，无需粘贴任何内容：

| 目标 | 伪造内容 | 效果 |
|:-----|:---------|:-----|
| **Qoder**（New Qoder app） | transcript + 明文 SQLite 会话行 | 侧边栏出现接续会话，点开即见全量历史，发消息直接接上源会话上下文 |
| **QoderWork** | chats/sub_chats 行 + 链重建 transcript + 消息预写 | 任务列表自动出现，历史消息完整渲染（含 thinking 卡片） |
| **Codex**（ChatGPT 桌面版） | 原生事件结构 rollout + threads 注册 | 会话列表出现接续会话，全量轮次历史原生渲染 |
| **codexcli**（终端 TUI） | 原生事件结构 rollout | `codex resume` 携带完整对话启动 |

源是 Qoder / QoderWork 同族时，thinking 块和工具调用结构原样保留；跨源（如 Claude → Qoder）则逐条消息转换，保真度远高于文档转述。

## 使用

### 交互模式（默认）

直接运行 `qc`，自动发现全部会话，选择一个，再选去哪继续：

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

在项目目录下运行时，该目录的会话优先展示。

### 快速恢复

跳过选择器，直接恢复某工具最近第 N 个会话（同工具原生 resume，全量历史）：

```bash
qc claude        # 最近的 Claude 会话
qc codex 3       # Codex 第 3 新的会话
qc qoder         # 最近的 Qoder 会话
qc qwen-code     # 最近的 Qwen Code 会话
```

全部工具通用。

### 跨工具接续

核心场景——在一个工具里开始，换另一个工具收尾：

```bash
# Claude 额度用完了？转给 Gemini：
qc resume abc123 --in gemini

# 接续到 Qoder（自动伪造原生会话，无损）：
qc resume abc123 --in qoder

# 接续到 Codex 桌面版（伪造 rollout + threads，无损）：
qc resume abc123 --in codex

# 接续到 codexcli 终端（伪造 rollout，resume 启动）：
qc resume abc123 --in codexcli

# 透传 flag 给目标工具：
qc resume abc123 --in codex --yolo --search --add-dir /tmp

# 只打印交接 prompt，不启动目标工具（调试用）：
qc resume abc123 --in codex --debug-prompt
```

`qc` 会把常见 flag（模型、沙箱、自动审批、附加目录）映射为目标工具的等价参数，不认识的按原样透传。

### 脚本化 & CI

```bash
qc list                          # 表格输出
qc list --source claude --json   # JSON，按来源过滤
qc list --jsonl -n 10            # JSONL，最近 10 条
qc scan                          # 发现统计
qc scan --rebuild                # 强制重建索引
```

### 检查（调试用）

精确看到解析出了什么、进了交接文档什么：

```bash
qc inspect abc123                              # 诊断视图
qc inspect abc123 --preset full --write-md handoff.md   # 导出完整 markdown
qc inspect abc123 --truncate 50                # 紧凑单行视图
```

### 批量导出

把全部会话导出为文件，用于备份、分析或归档：

```bash
qc dump all ./sessions                  # 全部导出为 markdown
qc dump claude ./sessions/claude        # 只导出 Claude 的
qc dump all ./sessions --json           # 导出为 JSON
qc dump all ./sessions --preset full    # 完整详尽模式
qc dump all ./sessions --limit 50       # 限制数量
```

文件命名：`{source}_{id}.md` 或 `{source}_{id}.json`

## 详略控制

不是每次交接都要写篇小说。四个预设控制文档详略：

| 预设 | 消息数 | 工具采样 | 子代理详情 | 适用场景 |
|:-----|:-------|:---------|:-----------|:---------|
| `minimal` | 3 | 0 | 无 | 快速上下文、token 受限的目标 |
| `standard` | 10 | 5 | 500 字符 | 默认——均衡 |
| `verbose` | 20 | 10 | 2000 字符 | 调试、复杂多文件任务 |
| `full` | 50 | 全部 | 全部 | 完整会话捕获 |

```bash
qc resume abc123 --preset full
```

### YAML 配置

项目级默认配置，在项目根目录放 `.continues.yml`：

```yaml
preset: verbose
recentMessages: 15
shell:
  maxSamples: 10
  stdoutLines: 20
```

解析顺序：`--config <path>` → 当前目录 `.continues.yml` → `~/.continues/config.yml` → `standard` 预设。完整配置项见 `.continues.example.yml`。

## 提取了什么

每个工具的会话存储都不一样——格式不同、schema 不同、路径不同。`qc` 统一读取：

| 工具 | 格式 | 位置 |
|:-----|:-----|:-----|
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
| Antigravity | PB + brain artifacts | `~/.gemini/antigravity/` |
| Kimi CLI | JSONL + JSON | `~/.kimi/sessions/` |
| Qwen Code | JSONL | `~/.qwen/projects/*/chats/` |
| Qoder | JSONL | `~/.qoder/projects/` |
| QoderWork | JSONL + JSON | `~/.qoderwork/projects/` |

全部读取均为**只读**——`qc` 绝不修改你的会话文件。索引缓存在 `~/.continues/sessions.jsonl`（5 分钟 TTL，自动刷新）。

### 交接文档中的工具活动

交接文档包含 **Tool Activity** 段落，让目标 agent 知道*做过*什么，而不只是*说过*什么：

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

对全部工具生效——bash 命令、文件读写编辑、grep/glob、MCP 工具调用、thinking 块、子代理派发、token 用量、模型信息。共享的 `SummaryCollector` 保证格式跨源一致。

每份交接文档还包含源会话的**完整文件路径**，目标工具需要时可回溯原始数据。

## 命令速查

| 命令 | 作用 |
|:-----|:-----|
| `qc` | 交互式 TUI 选择器 |
| `qc list` | 列出会话（`--source`、`--json`、`--jsonl`、`-n`） |
| `qc resume <id>` | 按 ID 接续（`--in <tool>`、`--preset`） |
| `qc inspect <id>` | 诊断视图（`--truncate`、`--write-md`、`--preset`） |
| `qc dump <source\|all> <dir>` | 批量导出（`--json`、`--preset`、`--limit`） |
| `qc scan` | 发现统计（`--rebuild`） |
| `qc rebuild` | 强制重建会话索引 |
| `qc <tool> [n]` | 快速恢复某工具第 N 新的会话 |

全局 flag：`--config <path>`、`--preset <name>`、`--verbose`、`--debug`

## 环境要求

- **Node.js 22.5+**（OpenCode 和 Crush 解析依赖内置 `node:sqlite`）
- 至少安装了一个支持的工具

## 开发

本仓库基于上游 [yigitkonur/cli-continues](https://github.com/yigitkonur/cli-continues) 开发并保持完全兼容——上游的全部能力（各工具 parser、交接流程、CLI 用法）原样可用；Qoder 系的增强（Qoder / QoderWork / qodercli 适配器、Codex 伪造、GUI 应用接续目标）在此之上叠加。

```bash
git clone https://github.com/llsgg/qoder-continues.git
cd qoder-continues
pnpm install

pnpm run dev          # tsx 直接运行，无需构建
pnpm run build        # 编译 TypeScript
pnpm test             # 跑测试
pnpm run test:watch   # watch 模式
```

要加新工具？在 `src/parsers/` 写一个 parser，把工具名加进 `src/types/tool-names.ts`，在 `src/parsers/registry.ts` 注册。registry 有编译期完整性检查——加了名字没写 parser，import 时直接抛错。

## License

MIT © [Yigit Konur](https://github.com/yigitkonur)
