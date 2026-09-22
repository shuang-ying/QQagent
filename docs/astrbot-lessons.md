# 参考 AstrBot 的设计取舍

本文记录对照 [AstrBot](https://github.com/AstrBotDevs/AstrBot) 后，本项目**借鉴了什么、没借鉴什么、以及为什么**。
不是"抄一个更成熟的方案"，而是挑出对我们这个规模真正有价值的部分。

参考的具体源码（AstrBot `master`）：

- `astrbot/core/persona_mgr.py` — 人格管理
- `astrbot/core/conversation_mgr.py` — 会话/对话管理
- [`docs.astrbot.app/use/context-compress.html`](https://docs.astrbot.app/use/context-compress.html) — 上下文压缩

---

## 一、AI 设定（人格）

### ✅ 已借鉴：预设对话（AstrBot 的 `begin_dialogs`）

**AstrBot 的做法**：人格除了 `system_prompt`，还有 `begin_dialogs`（预设对话），
会被转成真实的 `user`/`assistant` 消息对，插在 system 之后发给模型，
并标记 `_no_save` 不落库。条数必须是偶数，否则报错并清空。

**为什么要借鉴**：few-shot 示例作为**真实对话轮次**，比写在 system prompt 文字里
更能稳定住人格语气和回答风格。而且我们原本的 `examples` 字段是**死配置** ——
schema 里有、面板能编辑、API 会统计，但**从来没有发给模型**。

**我们的实现**（更结构化）：

| 点 | AstrBot | 本项目 |
|---|---|---|
| 数据结构 | 扁平字符串数组，靠下标判角色 | `[{user, assistant}]`，语义明确 |
| 校验 | 条数必须偶数 | zod 结构化校验，不需要这条规则 |
| 上限 | 无显式上限 | 最多 4 轮，且**计入 token 预算** |
| 落库 | `_no_save` 标记跳过持久化 | 只存在于本次请求的 messages，本来就不落库 |

放在 `src/context/compressor.ts` 的 `build()` 里，通过 `personaExamples` 参数传入，
示例的 token 从历史预算里扣 —— 宁可少放历史，也要保住风格。

面板「人格 → 编辑」里可以按 `用户说=它回答` 每行一条填写。

### ✅ 已借鉴：人格专属错误文案（`custom_error_message`）

AstrBot 每个人格可以配 `custom_error_message`，模型调用失败时用这句回。
我们原本硬编码了一句猫娘口吻的 `（呜…刚刚走神了一下，能再说一遍吗）` ——
换成冷酷助手人格时就很跳。

现在 `errorMessage` 是人格字段，6 个人格各写各的；留空则回落到通用文案。

### ⏸ 未借鉴：人格存数据库 + 文件夹树 + 排序

AstrBot 把人格（和文件夹）存进 SQLite，支持二级文件夹、`sort_order`、拖拽排序。
**不做的原因**：那是为"几十上百个人格 + Web 后台统一管理"设计的。
我们的人格是 `config/personas/*.yaml`，可以直接用编辑器改、能用 git 记录、
能随项目一起分发；面板也支持增删改。人格数量在个位数时，文件方案更简单也更好维护。

### ⏸ 未借鉴：persona 绑 tools / skills

AstrBot 每个人格可以限定能用哪些工具和技能（`tools=None` 表示全部，`[]` 表示禁用）。
**不做的原因**：本项目没有工具调用能力（见 `README` 的「安全边界」），
没有可限制的对象。如果将来加工具，这个设计值得直接抄 —— 按人格限权是很好的粒度。

---

## 二、记忆系统

### 对照表

| 维度 | AstrBot | 本项目 |
|---|---|---|
| 存储 | SQLite（对话内容 JSON 存库） | SQLite，消息**逐条**存表 + FTS5 全文索引 |
| 会话划分 | 会话(session) 与 对话(conversation) **分离** | `scope`（`private:{qq}` / `group:{gid}`）一层 |
| 一个会话下的多话题 | ✅ 支持多对话 + 切换 + 删除 + 标题 | ❌ 单条时间线 |
| 人格绑定 | 挂在 **conversation** 上（+ 会话级强制覆盖 + 全局默认） | 挂在 **session** 上（+ 用户级 + 配置 scope + 默认） |
| token 统计 | 每个对话记录 `token_usage` | 按模型统计（面板「Token 用量」），非按会话 |
| 写盘 | 攒 60 秒批量保存 | 每条消息即时写入（WAL） |
| 级联清理 | `register_on_session_deleted` 回调，供插件清理知识库 | 外键 `ON DELETE CASCADE`（如向量随事实删除） |
| 长期事实 | 交给插件（多种社区记忆插件） | **内置**：自动抽取 + 跨会话共享策略 |
| 向量检索 | 交给插件（RAG 知识库插件） | **内置**：可选 embedding + 余弦召回 + 按需补算 |
| 上下文压缩 | 独立配置（阈值触发摘要） | 内置三层：裁剪 → 分层摘要(L1→L2→L3) → 事实沉淀 |

### ✅ 我们相对更强的地方（不是自夸，是有意的设计选择）

1. **FTS5 + 时间衰减 + 置信度加权**：AstrBot 本体不内置检索，靠插件。
   我们内建了关键词检索，并且**可选**升级为向量语义检索，未配置时自动退回，不会报错。
2. **分层摘要**：`memory.summary.maxLevel` 支持 L1→L2→L3 递归压缩，
   原文永久保留、只从 prompt 里移除。
3. **跨会话共享策略**：`crossScopeSharing: identity-facts | full | none` ——
   "只共享身份类中性事实、对话内容按群隔离"这个隐私模型，AstrBot 本体没有对应概念。
4. **事实投毒拦截**：记忆会被拼进 system prompt，所以我们在抽取阶段
   就拦掉指令型内容（见 `looksLikeInjection`）。这是安全考量，AstrBot 未涉及。

### ⏸ 未借鉴：会话 / 对话分离（多话题）——**这是最值得补的一块**

AstrBot 的模型是：一个会话（比如群 `123456789`）下面可以开**多个对话**，
可以切换、删除、起标题。好处：

- 用户说"开个新话题"就能把旧上下文归档，不用等自动摘要
- 群聊里不同话题互不污染
- 面板上能看到"这个话题聊了什么"

我们目前每个 scope 只有一条时间线，话题切换只能靠自动摘要+时间衰减。
**没做的原因**：这是一次 schema 改造（新增 `conversations` 表、
`messages` 加 `conversation_id`、`sessions` 记录当前对话、
面板加对话管理页、QQ 内加 `/new` `/switch` 命令），
影响面比前面两项大得多，不适合顺手塞进这轮改动。

**如果要补，建议这样落地**：

```
conversations(id, scope, title, persona_id, created_at, last_active, archived)
messages 增加 conversation_id 外键
sessions 增加 current_conversation_id
```

- 现有数据迁移：给每个 scope 建一个默认对话，把历史消息归进去
- 记忆检索从 `WHERE scope = ?` 改成 `WHERE conversation_id = ?`，
  **但跨会话身份事实仍按 user_id 查询**（这一层不要动，它是我们的隐私边界）
- QQ 内命令：`/new`（开新对话）、`/topics`（列出并切换）
- 面板：对话列表 + 切换 + 改名 + 删除

### ⏸ 未借鉴：60 秒批量写盘

AstrBot 攒 60 秒保存一次。我们每条消息即时写（SQLite WAL 模式下很快）。
**不做的原因**：批量攒盘有丢数据风险（进程崩溃丢最近 60 秒），
而 QQ 场景的消息频率（每分钟几条）远没到需要攒盘的量级。等真有性能问题时再说。

### ✅ 已借鉴：级联清理的思路

AstrBot 用回调链让各模块在会话删除时清理自己的数据。
我们用 SQLite 外键 `ON DELETE CASCADE` 达到同样效果
（删事实时向量自动删除，见 `fact_embeddings` 表定义），
少一层耦合，且由数据库保证一致性。

---

## 三、结论

| 借鉴项 | 状态 |
|---|---|
| 预设对话真正生效（few-shot） | ✅ 已实现，修复了死配置 |
| 人格专属错误文案 | ✅ 已实现 |
| 级联清理 | ✅ 用外键实现，等价效果 |
| 人格存库 + 文件夹 + 排序 | ⏸ 有意不做（文件方案更适合本项目规模） |
| 人格按 tools 限权 | ⏸ 无工具可限（若加工具应直接抄） |
| 会话/对话分离（多话题） | ⏸ **建议后续补**，已给出迁移方案 |
| 60 秒批量写盘 | ⏸ 有意不做（丢数据风险 > 收益） |

值得强调的是：AstrBot 把"长期记忆""向量检索"大量交给**插件生态**
（`astrbot_plugin_memory`、`astrbot_plugin_cat_rag`、`astrbot_plugin_livingmemory` 等），
本体保持精简。我们选择了**内置**这些能力 —— 代价是代码更多，
好处是开箱即用、不需要用户自己挑插件、且能与准入控制/提示词注入防御联动。
这是产品定位差异，不是优劣。
