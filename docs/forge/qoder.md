# Qoder（New Qoder app）原生会话伪造

> 逆向基线：Qoder App **0.1.6**（bundle id `com.qoder.app`，宿主 ChatGPT 时代之前的独立 app）。
> 注意与老的 "Qoder IDE.app"（VSCode 系，Quest 模式，四层存储含 memento）区分——老 IDE 的
> forge 已废弃删除，本文只讲 New Qoder app。

## 存储全景（全部明文，无加密无 memento）

| 层                                  | 位置                                                               | 作用                         |
| :--------------------------------- | :--------------------------------------------------------------- | :------------------------- |
| transcript                         | `~/.qoder/projects/<cwd-slug>/<uuid>.jsonl`                      | agent 上下文（cosy 运行时 resume） |
| chat\_sessions                     | `~/Library/Application Support/com.qoder.app.stable/main.sqlite` | 会话注册表（侧边栏列表数据源）            |
| chat\_session\_messages            | 同上库                                                              | UI 历史消息（明文 payload\_json）  |
| chat\_session\_sidebar\_placements | 同上库                                                              | 侧边栏排序/置顶                   |
| workspaces                         | 同上库                                                              | 工作区分组（root\_paths\_json）   |

与老 Qoder IDE 的本质区别：**没有内存 memento、没有账号加密**——外部写入持久有效，
app 运行与否都能 forge（WAL 并发安全）。

## transcript 格式（cosy 布局，与 QoderWork 同源）

每行一个 JSON，关键字段 `type` + `sessionId`，消息行有 `uuid`/`parentUuid` 链：

```jsonl
{"type":"workspace-directories","sessionId":"<uuid>","directories":["<cwd>"]}
{"type":"runtime-config","sessionId":"<uuid>","model":"gmodel","reasoningEffort":null,"contextWindow":null,"generation":null,"timestamp":<ms>}
{"type":"user","uuid":"<id>","timestamp":"<ISO>","message":{"role":"user","content":[{"type":"text","text":"..."}]},"parentUuid":null,"isSidechain":false,"cwd":"...","sessionId":"...","promptId":"<uuid>","humanInput":{"text":"...","mode":"prompt"},"requestSetId":"<turnId>","origin":{"kind":"human"},"permissionMode":"auto","userType":"external"}
{"type":"assistant","uuid":"<id>","timestamp":"<ISO>","message":{"id":"<msgId>","type":"message","role":"assistant","model":"gmodel","stop_reason":"end_turn","content":[{"type":"text","text":"..."}]},"parentUuid":"<prev>","isSidechain":false,...}
{"type":"last-prompt","sessionId":"<uuid>","lastPrompt":"<最后一条用户输入>"}
{"type":"active-leaf","sessionId":"<uuid>","leafUuid":"<链尾uuid>","explicit":false,"timestamp":<ms>}
```

⚠️ **parentUuid 链必须严格连续**（首条为 null，之后逐条指向前条 uuid）。无链的 transcript
resume 报 `Invalid session identifier`。

⚠️ **assistant 流式分片要聚合成一条 UI 消息**——app 自己的投影会把一个 turn 的多个 text 分片
合并成一条；forge 时预聚合保持一致（`forgeNewQoderSessionData` 的 `flushAssistant`）。

⚠️ slug 规则：`cwd.replace(/[\/.:]/g, '-')`（路径分隔、点、冒号全转横杠）。

## chat\_sessions 行的关键字段

* **`registration_json` 必须为 NULL**——侧边栏 `listSessions` 的 SQL 过滤
  `registration_json IS NULL`（非空值是 app 的"输入注册中"临时标记，写了会话就永久隐形）

* `workspace_id`：分组归属。有真实项目目录 → 对应 workspace 组；
  **纯对话任务（qoderwork 隔离目录无 additional\_directories）→ NULL**，落入原生
  「最近任务」（no-workspace）分组——否则每次 forge 都造出一个垃圾 workspace 组

* 大量 NOT NULL 策略字段（`sandbox_policy`、`approval_mode`、`memory_mode`、`history_mode`
  等）：**从最新原生行模板复制**，别手写

* `extra_json`：`{"provisionalTitle":...,"titleResolved":true,"titleSource":"ai","titleRevision":0}`

## 消息行（chat\_session\_messages）

`payload_json` 明文，user/assistant 形态不同（注意 `turnId` 贯穿）：

```json
// user
{"id":"<turnId>","role":"user","turnId":"<turnId>","text":"...","timestamp":"<ISO>","tools":[],"attachments":[],...}
// assistant
{"id":"assistant:<turnId>","role":"assistant","turnId":"<turnId>","requestSetId":"<turnId>","text":"...","timestamp":"<ISO>","tools":[],"turnStartedAt":"...","durationMs":0}
```

## 窗口刷新（app 运行中让侧边栏看到新会话）

侧边栏目录**只在 renderer 初始化时查询**——无实时刷新、深链仅支持 mcp/invite、
MCP Router 有 apiKey 但只代理用户配置的外部 server。唯一可靠通道：

**点击「显示 → 重新载入」菜单**（View → Reload，Electron role:reload）触发 renderer 重载。

⚠️ 三个坑：

1. `process "Qoder"` 按名字匹配会撞上 **"Qoder IDE.app"**（同名！必须按 **bundle id
   `com.qoder.app`** 激活 + 按 **pid** 范围内点击）
2. pid 来源：`~/.qoder/mcp-router.json`（app 自己发布的 MCP router 发现文件，
   `{schemaVersion:2, pid, baseUrl, apiKey}`）——校验 `ps -p <pid> -o comm=` 精确等于
   `/Applications/Qoder.app/Contents/MacOS/Qoder`（helper 子进程共享路径前缀但带额外 argv）
3. 菜单是**动态的**（workbench 窗口态会换精简菜单）——点击失败重试一次；权限缺失时
   降级输出手动提示

## 跨源输入的过滤规则（`newQoderUserText`）

* qoderwork 的用户行：`<system-reminder>` 环境块与真实提问**拼在同一条 user 行的块数组里**
  → 必须逐块过滤（整行 `<` 前缀检查会误杀真实提问）

* `# Find Skills` 前缀 = QoderWork harness 注入的 skill 探测消息 → 跳过
  （其自身 UI 也不显示）

## 标题来源（选源列表与 forge 命名）

新版 QoderWork **不再写 `-session.json` sidecar**（改用 `<uuid>/` 目录）——任务真名只在
QoderWork agents.db 的 `chats.name`（AI 生成后更新）。`resolveQoderWorkContext` 查
`chats ⋈ sub_chats`（session id / chat id 双键索引）取标题 + 真实项目目录
（`additional_directories`，排除 `~/.qoderwork/workspace` 隔离前缀）。

统一标题约定（详见 [README.md](./README.md)）：

- **选源列表**读源会话原生标题（qoder 源 → `loadNewQoderTitleIndex` 扫本库 `chat_sessions.title`，
  按 transcript session id 对齐；无行则回退首条消息 summary）
- **forge 写入的接续标题** = `续 <源标题>`（`continuedSessionTitle`，qoderwork 源传入
  `resolveQoderWorkContext` 即时查到的最新 `chats.name` 作为 override）

## 验证方法

```bash
# forge 一个真实会话后
sqlite3 ~/Library/Application\ Support/com.qoder.app.stable/main.sqlite \
  "SELECT title, workspace_id FROM chat_sessions ORDER BY created_at DESC LIMIT 3;"
# app 运行中 → 看 CLI 输出 "window reloaded"；UI 侧边栏核对
```
