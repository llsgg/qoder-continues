# Forge 文档 — Qoder 系无损接续的逆向方案

> **目标读者**：接手本仓库后续开发的 agent / 人。这些文档沉淀了 Qoder / QoderWork / Codex
> 原生会话伪造（forge）的全部逆向结论与踩坑记录。**先读这里再动代码**——每一条格式细节
> 都是实验实锤的，跳过直接扫代码会重新踩一遍坑。

## 文档索引

| 文档 | 内容 |
|:-----|:-----|
| [qoder.md](./qoder.md) | New Qoder app（com.qoder.app）——SQLite 四层存储 + 窗口刷新 |
| [qoderwork.md](./qoderwork.md) | QoderWork——agents.db + 隐形标记任务刷新侧边栏 |
| [codex.md](./codex.md) | Codex 桌面版 + codexcli——rollout 双投影 + threads 注册 |

## 统一架构

### forgeHandoffSession 钩子

`src/parsers/registry.ts` 的 ToolAdapter 接口提供可选 `forgeHandoffSession`：

```ts
forgeHandoffSession?: (session, handoffPath, recentMessages?) => Promise<{
  chatId: string;          // 伪造出的会话 id
  taskName: string;        // 显示标题
  prepopulated: number;    // 写入的历史消息数
  resumeArgs?: string[];   // CLI 目标：spawn 参数（替代 prompt 注入）
  appWasRunning?: boolean; // GUI 目标：app 是否已在运行
  refreshed?: boolean;     // GUI 目标：是否已刷新 UI
} | null>
```

- **GUI 目标**（qoder / qoderwork / codex）：forge 自己拉起/刷新 app，返回 null 时降级为剪贴板 handoff
- **CLI 目标**（codexcli）：返回 `resumeArgs`，`src/utils/resume.ts` 用它 spawn 二进制替代 handoff prompt

### 消息保真顺序（三级 fallback）

`resume.ts` 跨源接续时按以下优先级取对话内容：

1. **源 transcript 原生行**——同为 Qoder 家族时（qoder↔qoderwork），thinking 块、工具调用结构原样保留
2. **统一消息转换**——跨源（claude/codex/gemini → qoder 系）时，`conversationToQoderLines` / `conversationToCodexItems` 逐条转换
3. **handoff 文档**——最后兜底，整份 markdown 塞成一条消息

⚠️ 提取给 forge 的 `recentMessages` **不设窗口上限**（`resume.ts` 中 `recentMessages: 100_000`）。
曾经用 full 预设的 50 条上限，长会话 forge 出来只有最近 50 条、且窗口开头全是 assistant 时
整个折叠成单个退化 turn——这是已修复的历史 bug。

### 统一标题约定（`src/utils/session-title.ts`）

选源列表与接续命名的单一真相来源，优先级：**原生注册表标题 > summary > 首条用户提问**。

- **选源会话列表**：展示源会话的原生标题（`UnifiedSession.title`，parser 侧从各自注册表读：
  qoder → `chat_sessions.title`，qoderwork → `chats.name`，codex → `threads.title`；
  无注册表行的源回退 summary）
- **接续会话标题**：统一为 `续 <源会话标题>`（`continuedSessionTitle`，源标题截 40 字符）。
  三个 forge 全部走它，不再各自拼「接续 xxx 会话：yyy」

### 关键代码位置

| 模块 | 文件 |
|:-----|:-----|
| Qoder GUI forge | `src/parsers/qoder.ts`（`forgeNewQoderHandoffSession`） |
| QoderWork forge | `src/parsers/qoderwork.ts`（`forgeQoderWorkHandoffSession`） |
| Codex CLI/GUI forge | `src/parsers/codex.ts`（`forgeCodexHandoffSession` / `forgeCodexGuiHandoffSession`） |
| 统一消息转换 | `qoder.ts` 的 `conversationToQoderLines`；`codex.ts` 的 `conversationToCodexItems` |
| 标题解析/接续命名 | `src/utils/session-title.ts`（`sourceSessionTitle` / `continuedSessionTitle`） |
| 钩子调用与降级 | `src/utils/resume.ts` 的 `crossToolResume` |

## 通用注意事项

- 所有 forge 写入均为**外部直写目标工具的本地存储**（SQLite WAL 并发安全 / JSONL 追加）
- forge 失败一律返回 `null` 静默降级，不抛错
- 涉及 AppleScript（System Events 菜单点击）需要终端宿主具备 **macOS 辅助功能权限**；缺失时
  CLI 输出手动操作提示
