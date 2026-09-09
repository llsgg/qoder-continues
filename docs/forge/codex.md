# Codex 原生会话伪造（桌面版 + CLI）

> 逆向基线：codex-cli **0.153.4** + ChatGPT.app 内置 Codex 桌面版（bundle id `com.openai.codex`，
> 进程名 ChatGPT）。CLI 与桌面版**共享 `~/.codex` 存储**。

## 存储全景

| 层 | 位置 | 作用 |
|:---|:-----|:-----|
| rollout | `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO时间戳>-<uuid>.jsonl` | 唯一真相源：agent 上下文 + UI 历史投影都源于它 |
| threads 注册表 | `~/.codex/state_5.sqlite`（threads 表） | 桌面版会话列表（`rollout_path` 指向 rollout 文件） |
| 历史投影 | `~/.codex/thread_history_1.sqlite`（thread_turns / thread_items） | 桌面版 UI 历史渲染（app-server 启动时扫描 rollout 生成） |

## rollout 格式——双投影是核心

每行 `{timestamp, ordinal, type, payload}`。**每条消息必须写两遍**：
`response_item` 行给 agent resume 回放；`event_msg item_completed` 行给桌面版
历史投影器消费（它**只认 event_msg，不认 response_item**——只写后者 UI 全空，实测）。

一个 turn 的完整结构（`forgeCodexRolloutLines`）：

```jsonl
{"type":"session_meta","payload":{"session_id":"<uuid>","id":"<uuid>","timestamp":"<ISO>","cwd":"<cwd>","originator":"codex-cli","source":"cli","thread_source":"user", ...模板复制}}
{"type":"event_msg","payload":{"type":"task_started"}}
{"type":"turn_context","payload":{"turn_id":"<uuidv7>","root_turn_id":"<同>","cwd":"...","workspace_roots":["..."], ...模板复制}}
{"type":"response_item","payload":{"type":"message","id":"msg_<uuid>","role":"user","content":[{"type":"input_text","text":"..."}]}}
{"type":"event_msg","payload":{"type":"item_completed","thread_id":"<会话uuid>","turn_id":"<turnId>","item":{"type":"UserMessage","id":"<uuidv7>","content":[{"type":"text","text":"..."}]}}}
{"type":"response_item","payload":{"type":"message","id":"msg_<uuid>","role":"assistant","content":[{"type":"output_text","text":"..."}]}}
{"type":"event_msg","payload":{"type":"item_completed","thread_id":"<会话uuid>","turn_id":"<turnId>","item":{"type":"AgentMessage","id":"msg_<24位hex>","content":[{"type":"Text","text":"..."}]}}}
{"type":"event_msg","payload":{"type":"task_complete","turn_id":"<turnId>"}}
```

### ⚠️ 大小写陷阱（实测踩坑最深的点）

| 项 | UserMessage | AgentMessage |
|:--|:-----------|:-------------|
| content block `type` | 小写 `"text"` | **大写 `"Text"`** |
| item `id` 形态 | `uuidv7` | `msg_` + 24 位 hex |

写错大小写 → 投影器产出 `userMessage` 类型但 AgentMessage 全部丢失（UI 只有用户消息）。

### 其他要点

- **turn_id 用 uuidv7**（时间有序，匹配 codex 原生 id 形态——`uuidv7()` 在 `codex.ts`）
- **session_meta / turn_context 模板复制**自最新原生 rollout（`latestCodexRolloutTemplates`）
  ——base_instructions、sandbox_policy 等字段随安装版本演进，手写必翻车
- 消息窗口开头若全是 assistant（其 user turn 落在窗口外）→ 折叠进**合成开头 turn**
  （否则 TUI resume 直接丢掉这些消息）
- assistant 的 reasoning 是 `encrypted_content`（模型侧加密）——**thinking 无法伪造**，
  只有对话文本跨格式边界
- 新版 rollout 的用户输入只有 `response_item role=user` 行（无 `event_msg user_message`）
  ——parser 侧 `parseSessionInfo` 提取摘要时注意（跳过 `<recommended_plugins>` 等
  harness 注入行）

## threads 注册（桌面版列表可见）

`registerCodexThread` 向 state_5.sqlite 的 threads 表 INSERT：

- **整行模板复制**自最新原生**普通用户行**（`WHERE thread_source='user'`；大量 NOT NULL
  策略字段），改写 id/rollout_path/时间戳
- **列表渲染的是 `first_user_message` / `preview` 字段，不是 `title`**——必须填可识别的
  接续标题（统一格式「续 <源标题>」；曾填了源会话中段一句"那刚刚你改的代码是不是白改了"，
  用户找不到会话）

⚠️ **history_mode 两边必须一致且必须是 `paginated`**（threads 行 + rollout session_meta
都强制写 paginated，`registerCodexThread` / `forgeCodexRolloutLines`）。三种组合实测
（0.153.4 桌面版，日志 `~/Library/Logs/com.openai.codex/`）：

| 组合 | resume | 历史 |
|:---|:---|:---|
| 错配（threads legacy + meta paginated） | ❌ `list_turns is not supported yet`（-32601） | — |
| 双 legacy | ✅ | ❌ UI 直接跳过历史加载（不调 `thread/turns/list`，历史空白） |
| **双 paginated** | ✅ | ✅ UI 走 `thread/turns/list` + `thread/items/list` 从 rollout 水合 |

模板来源各异（threads 模板可能是 guardian 行=legacy，rollout 模板可能是 VS Code
会话=paginated），所以两边都必须强制覆盖，不能依赖模板值。

⚠️ **模板绝不能取 subagent/guardian 行**（thread_source 为 `guardian_review`/`subagent`）。
曾因"最新行"恰是 codex 自动审查（guardian）会话，把 `model=codex-auto-review`、
`approval_mode=never`、只读 sandbox 一起复制了过来——后续对话会以审查模式运行，必须排除。

## 桌面版列表刷新

app 运行中，会话列表**只在窗口创建时重新查询**（无实时刷新、Cmd+R 被拦截、无菜单 Reload、
app-server 不做 rollout 实时 backfill——启动扫描才有）。

**解法：点击「文件 → 新建窗口」**（`openCodexNewWindow`，System Events）。菜单栏 item 与
菜单项都要 **zh/en 双标签尝试**（menu bar item 「文件/File」、item「新建窗口/New Window」
——只试 item 双语而菜单名硬编码中文，英文菜单环境下必失败）。点击重试 2 次：
app 刚被拉起时菜单栏可能还没就绪（实测 forge 后 30 秒内点击失败、重试成功）。
新窗口加载列表 → 伪造会话可见，app 不重启。

点击失败时 CLI 会按 app 输出手动指引（`guiRefreshHint`——ChatGPT 提示新建窗口，
Qoder 提示 View → Reload，不要把 Qoder 的菜单路径给 ChatGPT 用户看）。

## 两个接续目标

| 目标 | 机制 |
|:-----|:-----|
| `codex`（桌面版） | rollout + threads 注册 + `open -a ChatGPT` + 运行中开新窗口刷新 |
| `codexcli`（终端） | 仅 rollout（threads 由 `codex resume` 执行时自动注册）+ 返回 `resumeArgs: ['resume', '<id>']`，`resume.ts` 据此 spawn |

CLI 目标的 `codex resume <uuid>` 按会话 id 全树扫描 sessions/，rollout 放今天的日期目录即可。

## 验证方法

```bash
# forge 后核对 threads 行与投影
sqlite3 ~/.codex/state_5.sqlite "SELECT id, first_user_message FROM threads ORDER BY created_at DESC LIMIT 2;"
sqlite3 ~/.codex/thread_history_1.sqlite "SELECT item_type, COUNT(*) FROM thread_items WHERE thread_id='<id>' GROUP BY item_type;"
# CLI 上下文验证（非交互）
codex exec resume <forged-id> "这个会话里用户最初问什么？一句话" --skip-git-repo-check
```
