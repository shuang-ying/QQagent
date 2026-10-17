# GitHub 动态追踪（作者 + 仓库订阅）

管理面板 **📡 GitHub 追踪** 页支持两种可以并存的模式：

- **作者动态**：追踪一个或多个 GitHub 作者的公开动态（Push、Release、PR、Issue、Fork、Star 等），并**自动订阅该作者本人 owner 的全部公开仓库**（commits / Release）。作者自动仓库与手动「订阅仓库」隔离，取消作者会一起取消。
- **仓库订阅**：手动订阅指定 `owner/repo`，按分支比对 HEAD SHA；有新提交就推送一条汇总，并可同时订阅 Release 新版本。仓库订阅直接查 `commits` / `releases`，不依赖 GitHub 公开事件流，通常比作者动态更即时、更可靠。

两种模式都把消息推送到**本页单独选定**的 QQ 会话。这里的会话与项目里的「群白名单 / 用户白名单」完全无关：即使某个群不在 `trigger.group.enabledGroups` 里，只要在本页添加了 `group:群号`，它就会收到 GitHub 消息；反过来，本页没添加的会话一条都不会收到。

---

## 1. 配置入口

面板左侧 **📡 GitHub 追踪**。所有设置保存在项目根目录的 `config/github.yaml`：

```yaml
enabled: true
mode: both          # authors | repos | both
aiSummary: true     # 仓库更新后是否用 AI 生成总结
intervalSec: 300
repoDiscoverySec: 10800  # 作者公开仓库发现间隔，默认 3 小时；与轮询独立
maxEventsPerPoll: 5
maxEventAgeHours: 24
apiBase: https://api.github.com
token: ''          # 可选，建议只放本机
eventTypes:        # 只影响「作者动态」
  - PushEvent
  - CreateEvent
  - ReleaseEvent
  - PullRequestEvent
  - IssuesEvent
  - IssueCommentEvent
  - ForkEvent
  - WatchEvent
  - PublicEvent
authors:
  - login: torvalds
    enabled: true
repos:
  - repo: octocat/Hello-World
    branch: main        # 留空 = 仓库默认分支
    releases: true      # 是否同时订阅 Release
    enabled: true
targets:
  - scope: group:10001
    enabled: true
  - scope: private:20002
    enabled: true
```

> `config/github.yaml` 可能包含个人 Token，已在 `.gitignore` 中，不会进入 Git。面板填完 Token 后看输入框下方是否显示「Token 已保存」；保存成功后下一轮请求会把限额从匿名 60 次/小时刷新为 5000 次/小时。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 总开关。关闭后不再自动轮询；面板的「立即检查」仍可手动试跑 |
| `mode` | `authors` | `authors` 作者公开事件 + 作者全部公开仓库 / `repos` 只手动订阅仓库 / `both` 两者同时。老配置没有该字段时按 `authors` 处理 |
| `aiSummary` | `true` | 仓库新提交/新 Release 是否调用摘要模型生成 AI 总结，追加在原始消息下方；失败或未配置模型时仍发送原文 |
| `intervalSec` | `300` | 追踪轮询间隔，60~3600 秒 |
| `repoDiscoverySec` | `10800` | 作者公开仓库发现间隔，300~604800 秒（默认 3 小时）；与追踪轮询独立 |
| `maxEventsPerPoll` | `5` | 每个作者/仓库每轮最多推送几条，超出的留到下一轮 |
| `maxEventAgeHours` | `24` | 只对作者动态生效：超过这个时长的旧动态直接忽略 |
| `apiBase` | `https://api.github.com` | 自建 GitHub Enterprise 可改，面板不暴露此项 |
| `token` | 空 | 可选。匿名 60 次/小时；填了 5000 次/小时。只写在本机配置文件 |
| `eventTypes` | 见上 | 只影响作者动态；未勾选的类型会被标记为 skipped |
| `authors` | 空 | `login` + `enabled`；用户名大小写不敏感，自动去重。追踪作者会自动带上其全部公开仓库 |
| `repos` | 空 | 手动订阅的 `repo`、`branch`（空=默认分支）、`releases`、`enabled`；最多 50 个，与作者自动仓库隔离 |
| `targets` | 空 | `scope` 为 `group:群号` 或 `private:QQ号`；两种模式共用，与白名单无关 |

---

## 2. 追踪模式

| 模式 | 轮询内容 | 适用场景 |
| --- | --- | --- |
| `authors` | `/users/{login}/events/public` + 该作者全部公开仓库的 `/repos/{owner}/{repo}/commits`、`/releases` | 想跟某个人的全部公开活动，并盯住他名下所有仓库 |
| `repos` | 只轮询手动订阅的 `/repos/{owner}/{repo}/commits` + `/releases` | 只关心某几个仓库的代码和版本，不追踪作者 |
| `both` | 以上两者 | 既跟人（含其全部公开仓库），也盯手动仓库 |

切换模式后，不属于当前模式的待推送事件会被标记为 skipped，避免切回来时突然补发一堆旧消息。修改会自动保存并热更新，约 1 秒内会提前跑一轮。

---

## 3. 作者动态

**添加作者**：输入 GitHub 用户名（可一次填多个，逗号或空格分隔）→「添加作者」。添加后自动保存并热更新。

- 用户名格式：1~39 位字母、数字或短横线，不能以短横线开头/结尾；最多 50 个。
- 首次加入某位作者时，第一轮成功拉取只**建立基线**：把这批历史事件记为 skipped，不推送。之后出现的新事件才会推送。
- 暂停（关闭作者的开关）或移除作者后，它遗留的待推送事件会被标记为 skipped，不会补发。

### 作者全部公开仓库（自动订阅）

追踪作者时，除了公开事件，还会自动发现并订阅**该作者本人 owner 的全部公开仓库**：

- 发现接口：`GET /users/{login}/repos?type=owner&per_page=100&page=N`，自动分页。
- 只取 `owner` 为该作者的公开仓库；`private: true` 跳过；包含 fork、archived；`size: 0` 的空仓库跳过。
- 每个自动仓库使用默认分支比对 HEAD SHA，并默认订阅 Release；有新提交/版本时走和手动仓库完全相同的汇总、AI 总结、去重、补发逻辑。
- 发现间隔由 `repoDiscoverySec` 控制，默认 3 小时，**与 `intervalSec` 追踪轮询独立**；面板「立即检查」会强制刷新一次仓库列表，其余轮次按发现间隔执行。
- 作者自动仓库不写入 `repos`，不出现在手动「订阅仓库」列表；面板单独显示在「作者自动订阅的仓库」。
- 取消/暂停作者会一起取消其自动仓库订阅、HEAD 状态和待推送事件；手动订阅不受影响。
- 新发现的仓库只建立基线，不补历史；作者仓库列表刷新后已消失的仓库会自动取消。
- 一个仓库既被手动订阅、又是该作者的公开仓库时，**只保留一份轮询**，手动配置的分支/Release 设置优先；取消作者后手动订阅继续存在。
- 作者自动仓库不受手动「订阅仓库」50 个上限限制；仓库很多时请求量会相应增加。

**与公开事件的去重**：

- `PushEvent` 与 `RepoPush` 按 `仓库 + head SHA` 视为同一次更新；
- `ReleaseEvent` 与 `RepoRelease` 按 `仓库 + release id` 视为同一次更新；
- 两条都还在待推送时，优先保留信息更完整的仓库订阅消息（含提交数、链接、AI 总结），作者事件标 skipped；
- 如果其中一条已经实际发送，则先发送者优先，后到的一条不再重复发送；
- PR、Issue、Star、Fork 等不会由仓库订阅产生，仍按作者公开事件正常推送。

**推送会话**：

- 手动填 `group:123456789` 或 `private:10001` 后点「添加会话」。
- 也可以展开「从机器人已知会话里选择」，直接点「添加」。
- 最多 50 个；同一 scope 自动去重。
- 删除或暂停会话后，该会话不再收到任何 GitHub 动态；其它会话不受影响。

> 会话只是「消息发到哪里」：不会创建或修改白名单，也不影响聊天准入。

### 支持的事件

| 事件 | 推送文案示例 |
| --- | --- |
| `PushEvent` | 🚀 推送 3 个提交到 torvalds/linux（附分支、前 3 条提交信息、commit 链接） |
| `CreateEvent` | 🆕 新建仓库 / 🌿 新建分支 / 🏷 新建标签 |
| `DeleteEvent` | 🗑 删除分支 / 标签 |
| `ReleaseEvent` | 🚀 发布 v1.2.0（预发布为 🧪） |
| `PullRequestEvent` | 🔀 打开 PR #42 / ✅ 合并 PR #42 / 🚫 关闭 PR #42 |
| `PullRequestReviewEvent` | 🔍 评审 PR #42（通过 / 请求修改 / 有评论） |
| `IssuesEvent` | 📌 新建 Issue / ✅ 关闭 Issue / 🔄 重新打开 |
| `IssueCommentEvent` | 💬 评论 Issue #42 |
| `CommitCommentEvent` | 💬 评论提交 abc1234 |
| `ForkEvent` | 🍴 Fork owner/repo → 新仓库 |
| `WatchEvent` | ⭐ Star owner/repo |
| `PublicEvent` | 🌍 仓库转为公开 |
| `MemberEvent` | 👥 添加/移除协作者 |
| `GollumEvent` | 📖 更新 Wiki |
| `DiscussionEvent` | 💬 讨论 #12 |

---

## 4. 仓库订阅

**添加仓库**：在「订阅仓库」里填 `owner/repo`（如 `octocat/Hello-World`），分支可留空使用默认分支，点「添加仓库」。添加后自动保存并热更新。

> 这里只管理**手动订阅**。追踪作者产生的自动仓库单独显示在「作者自动订阅的仓库」，不会写进 `repos`；取消作者时只取消作者自动仓库，手动订阅不受影响。

- 同一仓库大小写不敏感，自动去重；最多 50 个。
- 每个仓库可以单独暂停，或关闭 Release 订阅。
- 首次轮询只记录当前分支 HEAD 和最新 Release 作为**基线**，不推送历史。
- 之后每轮：
  1. `GET /repos/{owner}/{repo}/commits?per_page=50&sha={branch}`；
  2. 用上次保存的 HEAD SHA 在提交列表里定位；在它之前的提交就是新增提交；
  3. 推送一条汇总，包含**提交数、作者、每条提交首行**和 compare / commit 链接；
  4. 如果上次 HEAD 不在最近 50 条里（一次推了很多或历史被重写），改用 `compare/{old}...{new}` 拿准确提交数；compare 也失败时按最新一条汇总并注明「历史被重写」。
- Release：`GET /repos/{owner}/{repo}/releases?per_page=10`，只推送比基线更新的非草稿版本；预发布标为 🧪。一次发现多个新版本时按 `maxEventsPerPoll` 分批，剩下的下一轮继续。
- 每轮每个仓库通常只发 **2 个请求**（commits + releases），compare 只在必要时才发。
- 私有仓库：需要 Token 具备 `repo` 权限；只有公开仓库或 Token 有权访问的仓库才能读到 commits/releases。

### AI 总结更新内容

面板「追踪设置」里的 **用 AI 总结更新内容** 开关（`aiSummary`，默认开启）控制此功能：

- 只对**仓库订阅**（含作者自动仓库）的新提交 / 新 Release 生效；作者公开事件保持原文，不额外调用模型。
- 摘要基于**提交信息 / Release 说明**，不拉取 diff，避免一次推送消耗大量 token。
- 使用「模型用途 → 上下文摘要（summary）」指定的模型；未单独指定时沿用默认模型。
- 生成成功后追加在原始消息下方，最多 4 行，例如：

```
🤖 AI 总结
· 新增登录能力
· 修复若干问题
```

- 摘要失败、超时、未配置模型或关闭开关时，**原始更新消息照常发送**，只是没有 AI 总结。- 每条新提交/Release 只生成一次摘要；已存在的事件不会重复调用模型。关闭开关即可完全避免这部分模型调用。

### 仓库订阅消息示例

```
📦 GitHub 仓库 · octocat/Hello-World
🚀 main 有 2 个新提交
· abc1234 @octocat：feat: 新功能
· def5678 @octocat：fix: 修复问题
🔗 https://github.com/octocat/Hello-World/compare/abc...def
🕐 2026-10-17 18:30
🤖 AI 总结
· 新增登录能力
· 修复若干问题
```

```
📦 GitHub 仓库 · octocat/Hello-World
🚀 发布 v1.2.0
· 1.2.0
· 修复若干问题
🔗 https://github.com/octocat/Hello-World/releases/tag/v1.2.0
🕐 2026-10-17 18:30
🤖 AI 总结
· 新增登录能力
· 修复若干问题
```

---

## 5. 轮询、去重与补发

- **自动保存并热更新**：在面板修改开关、模式、作者、仓库或推送会话后，约 700ms 合并保存一次，并立即热更新追踪器；新作者/仓库立即建立基线、新增会话立即补发积压，不用等满轮询间隔，也不需要手动点保存。「立即保存」仅用于自动保存失败时重试。
- **倒计时**：面板的「下次检查」每秒在浏览器本地刷新，不会只在每 10 秒拉取状态时跳一下；到点后自动重新拉取状态。
- **恢复即补发**：OneBot 从离线恢复就绪时立即补一轮待推送事件，不必等下一个轮询周期。
- **Token 变更**：保存新 Token 或修改 `apiBase` 时会清空旧的限额缓存，不会继续等旧匿名额度的 reset 时间。
- **类型变更**：在面板取消某类作者事件后，已经排队的同类型事件在下次投递时标记为 skipped，不再补发。
- **AI 总结**：仓库更新生成后调用摘要模型，结果追加在原始消息下；关闭 `aiSummary`、模型未配置或调用失败时不影响原文发送。作者动态不调用。
- **去重**：作者事件按 GitHub 事件 `id` 去重；仓库订阅按 `repo-push:{repo}:{headSha}` / `repo-release:{repo}:{releaseId}` 去重。跨源用 `dedupe_key`：`push:{repo}:{headSha}`（PushEvent ↔ RepoPush）、`release:{repo}:{releaseId}`（ReleaseEvent ↔ RepoRelease）；两条都待推送时仓库消息优先，已发送时先到者优先。重启不会重复推送。
- **条件请求**：作者动态保存 `ETag`，下一轮带 `If-None-Match`；仓库订阅直接比对 HEAD，不需要 ETag。
- **限额**：响应头 `x-ratelimit-remaining` 为 0 时停止请求，等 `x-ratelimit-reset` 后再试；此时已有的待推送事件照常投递。
- **离线排队**：OneBot 未就绪时事件保持 `pending`，连接恢复后补发。
- **部分失败**：某个会话发送失败只重试该会话；已成功的会话不会收到第二遍。
- **重试上限**：同一事件最多 3 轮、或事件超过 48 小时，转为 `failed`，不会永久占用队列。
- **每轮上限**：每个作者/仓库每轮最多推 `maxEventsPerPoll` 条。
- **事件年龄**：作者动态超过 `maxEventAgeHours` 的旧事件直接 skipped；仓库订阅以 HEAD 差量为准，不受该限制。
- **保留期**：已完成/已跳过的记录保留 30 天，自动清理。

事件状态：

```
pending ──全部会话成功──> sent
   │
   ├──部分失败──> pending（下轮只补失败会话）
   └──3 轮 / 48 小时──> failed
其他：skipped（基线、类型未勾选、旧事件、无会话、作者/仓库暂停、模式切换）
```

GitHub 公开事件接口自身有几十秒到几分钟的缓存，作者动态达不到「秒级」；仓库订阅直接读 commits/releases，通常一次轮询内就能看到新提交。间隔 5 分钟是合理默认值。

---

## 6. 安全约定

- 提交信息、PR 标题、发行说明等来自 GitHub，属于**不可信文本**：只保留单行、截断长度。
- 发送时使用 OneBot 消息段数组（`text` 段），由 `toCqCodes` 转义 `&`、`[`、`]`、`,`，因此恶意提交信息里的 `[CQ:at,qq=all]` 不会变成真正的 @全体成员。
- Token 只写在 `config/github.yaml`，接口只返回 `tokenSet: true/false`，不回显明文；保存时也支持清空。
- 所有 `/api/github/*` 接口沿用面板已有的 token 鉴权。
- 推送目标只用于本功能，不写入白名单，也不改变聊天准入。

---

## 7. HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/github/state` | 配置（脱敏）+ 运行状态 + 作者/仓库/会话统计 + 最近动态与投递 + 已知会话 |
| POST | `/api/github/config` | 保存部分配置；服务端归一化、校验、原子写盘并热生效 |
| POST | `/api/github/poll` | 立即检查一轮（即使总开关关闭也允许）；已在检查中返回 409 |
| POST | `/api/github/test` | 给每个启用会话发一条测试消息 |

---

## 8. 数据表

| 表 | 用途 |
| --- | --- |
| `github_events` | 已拉取事件：去重键 `dedupe_key`、待推送队列、面板历史；仓库订阅的 `type` 为 `RepoPush` / `RepoRelease` |
| `github_deliveries` | 每个事件在每个会话的投递结果 |
| `github_authors` | 作者的 `ETag`、基线时间、上次检查、错误信息、公开仓库发现时间/错误 |
| `github_repos` | 所有实际轮询仓库（手动 + 作者自动）的 HEAD SHA、Release 基线、上次检查、错误信息 |
| `github_author_repos` | 作者与公开仓库的映射；与手动 `repos` 配置隔离 |

数据库 Schema 版本随之升到 8；升级时沿用既有的自动备份流程。`github_events.dedupe_key` 有部分唯一索引（空字符串不冲突），用于跨来源去重。

---

## 9. 排查

| 现象 | 处理 |
| --- | --- |
| 作者标记「待建基线」 | 等第一轮成功拉取；若一直不消失，看「拉取失败」提示（用户名错误、网络、限额） |
| 仓库标记「待建基线」 | 等第一轮成功拉取；看是否 404（仓库/分支不存在或 Token 无权访问） |
| 限额剩余 0 | 等重置，或在面板填入 GitHub Token；新 Token 保存后会自动清掉旧限额缓存 |
| Token 已填但限额仍 60 | 确认 Token 输入框下方显示「Token 已保存」；未保存时点「保存 Token」或按回车。保存后下一轮 GitHub 请求会刷新限额；若持续 60，检查是否 401（Token 无效/过期） |
| Token 输入后状态一直「未保存」 | 新面板会在格式完整时自动保存；格式未识别时点「保存 Token」强制保存，或检查是否有多余空格/换行 |
| 状态一直「待推送」 | OneBot 是否在线；会话号是否存在；看「最近投递」里的错误 |
| 添加作者/仓库后没有消息 | 首次只建基线；之后有新动态/新提交才会推送，可点「立即检查」 |
| 推送了代码但没有消息 | 作者模式下确认作者已启用；仓库模式下确认手动订阅；确认推送的是订阅的分支；私有仓库需要 Token 有 `repo` 权限 |
| 作者自动仓库为空 | 首次发现失败看「发现失败」提示；作者可能没有公开仓库，或仓库是空仓库/私有仓库；「立即检查」会强制刷新一次仓库列表 |
| 作者自动仓库不刷新 | 默认 `repoDiscoverySec` 为 3 小时，与追踪轮询独立；点「立即检查」可强制刷新 |
| 修改后没生效 | 看页面顶部是否提示「自动保存失败」；可点「立即保存」重试，并检查网络或面板鉴权 |
| 没有 AI 总结 | 检查「用 AI 总结更新内容」开关；确认「模型用途 → 上下文摘要」已配置可用模型；看日志 `GitHub 更新 AI 总结失败` |
| 想看完整请求过程 | 日志关键字 `GitHub`：`已建立 GitHub 作者基线`、`已建立 GitHub 仓库基线`、`发现 GitHub 仓库新提交`、`发现 GitHub 仓库新 Release`、`GitHub 动态推送失败` |

---

## 10. 测试

```powershell
npm run test:github-tracker
```

覆盖：配置归一化与文件损坏回退、作者事件排版与 CQ 注入转义、仓库订阅配置、HEAD 基线/新提交/compare 回退、Release 基线/新版本、模式切换、作者公开仓库发现/取消、手动与作者仓库重叠、PushEvent↔RepoPush 跨源去重、AI 总结开关与失败回退、作者基线、离线排队、部分失败重试、304、限额、类型过滤、每轮上限、面板 API 脱敏、面板脚本编译。
