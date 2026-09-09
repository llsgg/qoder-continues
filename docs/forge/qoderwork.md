# QoderWork 原生任务伪造

> 逆向基线：QoderWork（Electron GUI agent，无 CLI）。存储全部明文 SQLite + cosy transcript。

## 存储全景

| 层 | 位置 | 作用 |
|:---|:-----|:-----|
| agents.db | `~/Library/Application Support/QoderWork/data/agents.db` | 任务注册 + UI 消息（chats / sub_chats / messages 三表） |
| transcript | `~/.qoderwork/projects/<cwd-slug>/<uuid>.jsonl` | agent 上下文（cosy 布局，与 qoder 同源，parentUuid 链必需） |
| MCP 服务 | `127.0.0.1:52345`（token 在 `~/.qoderwork/mcp-adaptor.config`） | 本地 agent 触发通道 |

### agents.db 关键表

- **chats**：任务行。`ext` 必须含 `{"activeLegokitId":"task-monitor","taskStatus":"completed"}`
  ——没有 `taskStatus` 时渲染器认为是"从未运行的任务"，显示空输入框而非预写历史
- **sub_chats**：`session_id` 列指向 transcript 文件名（uuid）——用户第一条消息时 agent
  原生 resume 这个 transcript
- **messages**：UI 历史投影（parts 数组，thinking 块存为 `tool-Thinking` 卡片）

## forge 主流程（`forgeQoderWorkHandoffSession`）

1. INSERT chats 行（ext 带 taskStatus:completed）
2. `forgeQoderWorkTranscript`——链重建的完整历史（用户首条消息即全量上下文续聊）
3. INSERT sub_chats（session_id 指向伪造 transcript；无 transcript 时留空串）
4. 创建**归档标记任务**（见下）触发侧边栏刷新
5. `prepopulateMessagesFromTranscript`——把源对话写成 messages 行（UI 无损）
6. 通过 MCP 服务触发标记任务的 agent 运行
7. `open qoder-work://all-chats` 深链打开"全部会话"视图

## 侧边栏刷新——四层缓存死局的解法

QoderWork 的 UI 缓存极其顽固（全部实验实锤）：

- `chats.list` 查询结果**永不失效**（外部 INSERT 不可见）
- 消息走内存 store（`staleTime:∞`、`refetchOnMount:false`）
- `⌘G` 搜索弹窗**实时查库**（立即可见，但不能当主通道）

**解法：隐形标记任务**。创建一个 `archived_at` 置值的牺牲任务（归档任务不进列表，
但其 agent 运行触发的任务事件会**全局失效 chats.list 缓存**）→ 真实任务随即出现在侧边栏。
`cleanupOldMarkerTasks` 清理历史残留。

⚠️ 早期版本标记任务未归档、与真实任务同名，用户点错任务排查了很久——**创建时必须归档**。

## 预写消息的防替换对齐

`shouldReplaceProjectionFromSdk` 逻辑：runtime 投影的消息数 > DB 行数时会**用投影覆盖预写行**。
解法：`isForgeableConversationLine` 过滤器在 transcript 链路与 messages 预写路径**共享**
（`forgeableSourceLines`），保证两侧数量一致，投影永不触发替换。

## qoderwork 源的解析要点（parser 侧）

- 新版**没有 `-session.json` sidecar**（会话目录改 `<uuid>/`）——标题与时间戳从
  agents.db `chats ⋈ sub_chats` 注册表读（`loadQoderWorkChatIndex`，
  `QODERWORK_DB_PATH` 可覆盖用于测试）；原生标题写入 `UnifiedSession.title`，
  接续标题统一为「续 <源标题>」（见 [README.md](./README.md)）
- 首条用户消息过滤：跳过 `# Find Skills` harness 探测行
- 真实项目目录：`chats.additional_directories[0]`（排除 `~/.qoderwork/workspace` 隔离前缀）

## 验证方法

```bash
sqlite3 ~/Library/Application\ Support/QoderWork/data/agents.db \
  "SELECT id, name, archived_at FROM chats ORDER BY created_at DESC LIMIT 3;"
# messages 数量与源对话一致；MCP 触发后侧边栏自动出现任务
```
