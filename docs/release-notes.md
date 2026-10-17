# 发行版更新记录

## 2.3.0（2026-10-17）

同步开发版功能到发行版，并明确内置 SnowLuma 的许可边界与安装方式。版本号统一升到 2.3.0（开发版与发行版同步），启动日志与后台仍从 `package.json` 读取版本。升级不需要手工迁移配置；数据库 schema 由 v5 升到 v7，启动时自动备份。

### 内置 SnowLuma（面板托管）

面板新增「❄ SnowLuma」页：在页面内安装、启动、停止独立进程，查看实时终端并使用上游原生管理界面，不需要一直开着命令行窗口。

- **发行包不含任何上游文件**。snowluma 采用源码可见非商业许可（不是开源许可），原生组件另有专有条款（EULA 第 5 条），因此它的源码、二进制、归档全部位于 Git 与 npm 排除的 `runtime/`，仓库只发布本项目自己的管理代码（`src/snowluma/`、`scripts/snowluma-runner.mjs`）与固定版本、SHA256 校验值清单。
- 安装按钮的行为是「从上游官方 GitHub 发布页下载到用户自己的机器」：固定 `v1.14.22`，校验 SHA256 后原子发布，失败不覆盖既有账号数据。另提供离线手动放置官方包的步骤（含校验值与 `installation.json` 示例）。
- 进程与数据分离：Agent 负责回复、模型、人格与记忆，snowluma 负责 QQ 协议和自己的界面，两者只通过 OneBot 连接；不会接管或停止你此前单独运行的 snowluma。
- 鉴权独立：`/api/snowluma/*` 受现有面板鉴权保护，控制操作拒绝跨站 Origin；内嵌界面通过 8 小时 HttpOnly、SameSite=Strict 会话 Cookie 经专用代理访问，SnowLuma 自己的登录 Token 独立使用。
- 修复启动包装层的官方入口参数，使数据库迁移工作线程能正常进入官方流程（`ERR_INVALID_ARG_TYPE` 不再出现）。

条款逐条对应、公开分发与商业使用前需要做什么、手动安装步骤见 `docs/snowluma-integration.md`。

### GitHub 作者动态追踪

新增「📡 GitHub 追踪」页与 `config/github.yaml`：追踪一个或多个作者的公开动态，推送到本页单独选定的 QQ 会话（与项目群/用户白名单无关）。首轮只建基线不刷历史，事件落库去重、重启不重发，离线后恢复只补发失败会话；支持 ETag、限额感知、每轮上限、旧事件跳过与可选 Token。不可信文本经消息段转义后发送。

### GitHub 仓库订阅（补充）

- 新增 `mode`（`authors` / `repos` / `both`）与 `repos` 配置；面板「追踪设置」可直接切换，老配置默认仍为作者动态。
- 面板修改自动保存并热更新：700ms 内合并连续操作，直接调用现有校验/原子保存/运行时同步流程；自动保存失败时保留本地状态并显示错误，可用「立即保存」重试。
- 订阅 `owner/repo`（分支留空 = 默认分支），每轮用 `/repos/{owner}/{repo}/commits` 比对 HEAD SHA，有新提交就推送一条汇总：提交数、作者、每条提交首行、compare / commit 链接。
- 上次 HEAD 不在最近 50 条里时自动用 `compare/{old}...{new}` 拿准确数量；compare 失败按最新一条汇总并注明；修改订阅分支会重建基线，不把新分支历史当新提交。
- 每个仓库可单独开启 Release 订阅：首次只记录最新版本，之后有新版本才推送，预发布标 🧪。
- 新增 `aiSummary` 开关（默认开启）：仓库新提交/新 Release 使用「上下文摘要」模型生成 2~4 行 AI 总结，追加在原始消息下方；基于提交信息/发布说明，不拉 diff。模型未配置、超时或失败时仍发送原文；关闭开关后完全不调用摘要模型。
- 追踪作者时自动发现并订阅该作者本人 owner 的全部公开仓库（默认分支 HEAD + Release），复用仓库订阅的汇总/AI 总结/投递逻辑；自动仓库不写入 `repos`、不显示在手动列表，取消作者一起取消，手动重叠时共用一份轮询。
- 新增 `repoDiscoverySec`（默认 10800 秒 / 3 小时），与追踪轮询独立；手动「立即检查」强制刷新仓库列表。发现失败时保留已有仓库并在面板显示错误。
- 新增跨源去重：`PushEvent` ↔ `RepoPush` 按 repo + head SHA、`ReleaseEvent` ↔ `RepoRelease` 按 repo + release id；两条都待推送时仓库消息优先，已发送时先到者优先。
- Token 输入框新增「保存 Token」按钮、回车保存和格式识别；完整 Token 自动保存，输入框下方显示「Token 已保存 / 未设置」；保存日志增加 `tokenSet`。限额显示标注 Token/匿名，保存后下一轮请求刷新；401 明确提示 Token 无效或过期。
- 修复 OneBot/NapCat 动作成功但回执缺少可靠 `message_id` 时被误判为失败的问题：现在按已发送处理，面板状态为「已推送」，不会重复补发；启动时自动修复历史误记记录并对齐已全部送达的事件。
- 仓库事件复用现有 `github_events` / `github_deliveries`，按 `repo-push:{repo}:{sha}` / `repo-release:{repo}:{id}` 去重，与作者动态共用本页推送会话。
- 数据库 schema 升到 v8：`github_events` 新增 `dedupe_key`，`github_authors` 新增公开仓库发现状态，新增 `github_author_repos` 映射表；升级前自动备份。新增 6 项作者仓库/去重/隔离/回执回归，GitHub 追踪测试共 28 项。

### 按用途 Token 预算

新增七项输出预算（`chat` / `vision` / `sticker` / `emotion` / `facts` / `summary` / `daily`），面板「概览 → 功能开关 → Token 预算」可视化调整，`0` 表示沿用该用途原有预算，因此发行版模板全部为 0、默认行为不变。另提供 `GET/PATCH /api/token-budgets` 部分更新接口，取值 0~131072，沿用原有校验与原子保存。

### 日志诊断增强

在不改变业务行为的前提下补充结构化诊断字段（模块与阶段、会话与轮次、供应商与用途、超时与耗时、失败类型、有界错误快照、OneBot 动作与结果、重试与回退路径）。日志中的密钥、Bearer、Cookie、签名 URL 与 base64 图片会脱敏，不记录消息正文、动作参数、请求体与认证头。新增 `npm run test:logging`。

### 主动发言节奏修正

统一主动发言的机会点、间隔与每小时上限判定，按会话隔离计数器；补充 `npm run test:proactive-cadence` 回归，确认并发与被取消的投递不会额外放大主动消息数量。

### 其他

- 新增文档：逐指令权限、GitHub 追踪、日志诊断、记忆/上下文/Embedding/情绪详解、人格上下文与结构化设定、主动发言相关度、回复窗口与对象归属、Token 预算、内置 SnowLuma。
- 数据库 schema 升到 v7；升级前自动用 `VACUUM INTO` 生成 `data/brain.db.pre-v7.<时间戳>.bak`，检测到数据库版本高于程序版本时拒绝降级启动。
- 未新增 npm 依赖，`engines` 仍为 `>=22.16.0`；三个 Windows 批处理与启动回归保持不变。
- 新增 `config/github.yaml` 脱敏模板（`enabled: false`、`token` 为空、`mode: authors`、`aiSummary: true`、`repoDiscoverySec: 10800`、`repos: []`）；`config/app.yaml` 补充 `llm.roles.asr`、`llm.tokenBudgets`、`tasks`、`speech` 示例项，其余默认值保持保守。

### 验证

`npm run typecheck` 通过；`npm run test:github-tracker` 通过（28 项，含作者公开仓库发现/取消、手动与作者重叠、Push/Release 跨源去重、AI 总结、无 message_id 回执与启动修复）；`npm run test:panel-isolated` 通过（5 项）；`test:persona-context` 12 项、`test-database-maintenance` 2 项、`test-config-atomic` 1 项通过。其余完整离线/接入回归沿用上一版记录；全部使用本地夹具和测试子进程，未调用真实模型、未发送真实 QQ 消息、未打开用户账号数据库。

## Windows 启动脚本修复

修复 GitHub ZIP 将批处理规范化为 LF 后，cmd.exe 把注释和路径片段当成命令的问题。三个批处理统一 ASCII/CRLF，Git属性保留原始字节；首次安装优先使用锁文件，依赖不完整时重装，失败立即停止，运行退出码保留。新增10项启动回归，覆盖含空格/特殊字符路径、首次安装、安装失败、运行失败和Git归档后的实际执行。

## Windows 终端中文编码修复

三个批处理在调用npm前切换代码页65001，避免中文UTF-8日志被系统代码页936解码。继续保持ASCII/CRLF和Git原始字节规则。新增回归从936启动三个脚本，验证安装、运行时均采用UTF-8且中文输出完整。


## 2.2.0（2026-10-05）

- 增加合并转发阅读，区分节点原作者、正文与图片来源。
- 增加ASR/TTS独立模型用途，支持OpenAI兼容、Gemini原生及自定义HTTP字段映射；人格独立音色、语速和朗读风格。
- 增加持久化提醒、手动/定时群聊日报、四项指令权限及后台任务管理。数据库使用v5，升级前自动备份。
- 增加链接与JSON/XML卡片理解，读取公开静态网页，接入主动/被动/引用上下文并隔离指令和记忆归属。
- 补齐功能使用文档和Git/npm打包白名单；保留Windows批处理ASCII/CRLF与UTF-8修复。
- 升级时保留自己的配置、人格和数据库。语音与日报默认关闭，需配置后开启。没有新增依赖。

版本统一为2.2.0，启动日志与后台从package.json读取版本；README补充全部语音参数的填写方法、默认值、协议差异、继承规则和自定义HTTP示例。

### 后台设置布局修复

修复语音等设置的说明被固定宽度输入框挤成一字一行的问题。文本、JSON、列表和下拉设置改用上下布局；数值与开关保留紧凑布局，设置卡片自适应列数，并适配窄屏导航。所有参数值与保存接口保持一致。后台5项检查通过；本次未连接真实QQ或语音API。
