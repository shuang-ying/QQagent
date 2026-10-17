# GitHub 作者动态追踪

管理面板新增 **📡 GitHub 追踪** 页：添加一个或多个 GitHub 作者，把他们的公开动态（提交、发布、PR、Issue、Fork、Star 等）实时推送到**本页单独选定**的 QQ 会话。

这里的推送会话与项目里的「群白名单 / 用户白名单」完全无关：即使某个群不在 `trigger.group.enabledGroups` 里，只要在本页添加了 `group:群号`，它就会收到 GitHub 动态；反过来，本页没添加的会话一条都不会收到。

---

## 1. 配置入口

面板左侧 **📡 GitHub 追踪**。所有设置保存在项目根目录的 `config/github.yaml`：

```yaml
enabled: true
intervalSec: 300
maxEventsPerPoll: 5
maxEventAgeHours: 24
apiBase: https://api.github.com
token: ''          # 可选，建议只放本机
eventTypes:
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
targets:
  - scope: group:10001
    enabled: true
  - scope: private:20002
    enabled: true
```

> `config/github.yaml` 可能包含个人 Token，已在 `.gitignore` 中，不会进入 Git。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 总开关。关闭后不再自动轮询；面板的「立即检查」仍可手动试跑 |
| `intervalSec` | `300` | 轮询间隔，60~3600 秒 |
| `maxEventsPerPoll` | `5` | 每个作者每轮最多推送几条，超出的留到下一轮 |
| `maxEventAgeHours` | `24` | 超过这个时长的旧动态直接忽略，避免停机几天后补发陈年事件 |
| `apiBase` | `https://api.github.com` | 自建 GitHub Enterprise 可改，面板不暴露此项 |
| `token` | 空 | 可选。匿名 60 次/小时；填了 5000 次/小时。只写在本机配置文件 |
| `eventTypes` | 见上 | 推送哪些事件类型；未勾选的类型会被标记为 skipped，不会补发 |
| `authors` | 空 | `login` + `enabled`；用户名大小写不敏感，自动去重 |
| `targets` | 空 | `scope` 为 `group:群号` 或 `private:QQ号`；与白名单无关 |

---

## 2. 添加作者与会话

**作者**：输入 GitHub 用户名（可一次填多个，逗号或空格分隔）→「添加作者」→「保存设置」。

- 用户名格式：1~39 位字母、数字或短横线，不能以短横线开头/结尾；最多 50 个。
- 首次加入某位作者时，第一轮成功拉取只**建立基线**：把这批历史事件记为 skipped，不推送。之后出现的新事件才会推送。
- 暂停（关闭作者的开关）或移除作者后，它遗留的待推送事件会被标记为 skipped，不会补发。

**推送会话**：

- 手动填 `group:123456789` 或 `private:10001` 后点「添加会话」。
- 也可以展开「从机器人已知会话里选择」，直接点「添加」。
- 最多 50 个；同一 scope 自动去重。
- 删除或暂停会话后，该会话不再收到任何 GitHub 动态；其它会话不受影响。

> 会话只是「消息发到哪里」：不会创建或修改白名单，也不影响聊天准入。

---

## 3. 支持的事件

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

每条消息形如：

```
📡 GitHub · torvalds
🚀 推送 2 个提交到 torvalds/linux
· 分支：master
· mm: fix page fault handling
· docs: 更新维护者名单
🔗 https://github.com/torvalds/linux/commit/abcdef1
🕐 2026-10-17 20:30
```

---

## 4. 轮询、去重与补发

- **保存即生效**：在面板保存设置后，如果作者或推送会话有增删/启停，约 1 秒内会提前跑一轮（新作者立即建立基线、新增会话立即补发积压），不用等满轮询间隔。
- **倒计时**：面板的「下次检查」每秒在浏览器本地刷新，不会只在每 10 秒拉取状态时跳一下；到点后自动重新拉取状态。
- **恢复即补发**：OneBot 从离线恢复就绪时立即补一轮待推送事件，不必等下一个轮询周期。
- **类型变更**：在面板取消某类事件后，已经排队的同类型事件在下次投递时标记为 skipped，不再补发。
- **去重**：按 GitHub 事件 `id` 落库（`github_events` 主键），同一事件只会推送一次，重启也不会重发。
- **条件请求**：每个作者保存 `ETag`，下一轮带 `If-None-Match`，GitHub 返回 `304` 时不消耗流量也不重复处理。
- **限额**：响应头 `x-ratelimit-remaining` 为 0 时停止请求，等 `x-ratelimit-reset` 后再试；此时已有的待推送事件照常投递。
- **离线排队**：OneBot 未就绪时事件保持 `pending`，连接恢复后补发。
- **部分失败**：某个会话发送失败只重试该会话；已成功的会话不会收到第二遍。
- **重试上限**：同一事件最多 3 轮、或事件超过 48 小时，转为 `failed`，不会永久占用队列。
- **每轮上限**：每个作者每轮最多推 `maxEventsPerPoll` 条，避免一次刷屏。
- **事件年龄**：超过 `maxEventAgeHours` 的旧事件直接 skipped。
- **保留期**：已完成/已跳过的记录保留 30 天，自动清理。

事件状态：

```
pending ──全部会话成功──> sent
   │
   ├──部分失败──> pending（下轮只补失败会话）
   └──3 轮 / 48 小时──> failed
其他：skipped（基线、类型未勾选、旧事件、无会话、作者暂停）
```

GitHub 公开事件接口自身有几十秒到几分钟的缓存，轮询达不到「秒级」；间隔 5 分钟是合理默认值。

---

## 5. 安全约定

- 提交信息、PR 标题、发行说明等来自 GitHub，属于**不可信文本**：只保留单行、截断长度。
- 发送时使用 OneBot 消息段数组（`text` 段），由 `toCqCodes` 转义 `&`、`[`、`]`、`,`，因此恶意提交信息里的 `[CQ:at,qq=all]` 不会变成真正的 @全体成员。
- Token 只写在 `config/github.yaml`，接口只返回 `tokenSet: true/false`，不回显明文；保存时也支持清空。
- 所有 `/api/github/*` 接口沿用面板已有的 token 鉴权。
- 推送目标只用于本功能，不写入白名单，也不改变聊天准入。

---

## 6. HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/github/state` | 配置（脱敏）+ 运行状态 + 作者/会话统计 + 最近动态与投递 + 已知会话 |
| POST | `/api/github/config` | 保存部分配置；服务端归一化、校验、原子写盘并热生效 |
| POST | `/api/github/poll` | 立即检查一轮（即使总开关关闭也允许）；已在检查中返回 409 |
| POST | `/api/github/test` | 给每个启用会话发一条测试消息 |

---

## 7. 数据表

| 表 | 用途 |
| --- | --- |
| `github_events` | 已拉取事件：去重键、待推送队列、面板历史 |
| `github_deliveries` | 每个事件在每个会话的投递结果 |
| `github_authors` | 作者的 `ETag`、基线时间、上次检查、错误信息 |

数据库 Schema 版本随之升到 6；升级时沿用既有的自动备份流程。

---

## 8. 排查

| 现象 | 处理 |
| --- | --- |
| 作者标记「待建基线」 | 等第一轮成功拉取；若一直不消失，看「拉取失败」提示（用户名错误、网络、限额） |
| 限额剩余 0 | 等重置，或在面板填入 GitHub Token |
| 状态一直「待推送」 | OneBot 是否在线；会话号是否存在；看「最近投递」里的错误 |
| 添加作者后没有消息 | 首次只建基线；之后作者有新动态才会推送，可点「立即检查」 |
| 修改后没生效 | 别忘了点「保存设置」；页面上有「有未保存的改动」提示 |
| 想看完整请求过程 | 日志关键字 `GitHub`：`已建立 GitHub 作者基线`、`GitHub 动态检查完成`、`GitHub 动态推送失败` |

---

## 9. 测试

```powershell
npm run test:github-tracker
```

覆盖：配置归一化与文件损坏回退、事件排版与 CQ 注入转义、基线、去重、离线排队、部分失败重试、304、限额、类型过滤、每轮上限、面板 API 脱敏、面板脚本编译。
