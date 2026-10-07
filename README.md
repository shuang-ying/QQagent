# QQ Agent

一个通过 **snowluma / 标准 OneBot v11** 接入 QQ 的 LLM 回复机器人，提供 Web 管理面板、人格、图片/语音理解、提醒与日报、链接卡片阅读及分层记忆。当前发行版本：**2.2.0**。

项目由作者提出需求、进行测试反馈，并在 AI 辅助下开发。此发行版不预置 API Key、个人 QQ 号或模型供应商；安装后请先完成模型和权限配置。

## 功能

- **被动回复**：私聊正常应答；群聊被 @ 或引用机器人时优先回复，回复对象固定为触发者。
- **主动插话**：根据消息数量、当前话题、人格兴趣及允许使用的记忆参与群聊，受概率、间隔、安静时段和小时上限控制。
- **完整回复窗口**：主动、被动回复都纳入上次确认回复之后、到本次生成开始前的聊天记录，包含排队期间的消息及图片来源。
- **人格系统**：7 个预设人格，支持结构化设定、示例对话、群/私聊独立人格，以及保留历史或新开话题的切换方式。
- **图片理解**：合并窗口图片、当前图片与明确引用的旧图，区分发送者；可用独立视觉模型识别资料，再由聊天模型回答。
- **合并转发**：读取节点作者、时间、文字与图片，支持嵌套及旧消息引用。
- **链接与卡片**：解析JSON/XML、小程序、音乐等卡片，并读取公开静态网页文字；主动、被动及引用问答共享资料。
- **语音理解与人格语音**：独立ASR/TTS模型，支持OpenAI兼容、Gemini原生和自定义HTTP；人格可设置音色、语速和朗读风格。
- **提醒与日报**：提醒持久化并在重启后恢复；日报只总结目标群已记录的最近24小时聊天，支持手动和每天定时发送。
- **分层记忆**：以 QQ 为用户身份，支持长期事实、关键词检索、可选向量检索、摘要压缩、纠错和遗忘。
- **指令权限**：每条指令可在后台设置为管理员、全部用户、用户白名单和管理员。
- **可靠投递**：会话串行、直接请求优先、消息去重、连接与账号就绪检查、过时主动任务取消及发送结果记录。

## 环境要求

| 组件 | 要求 |
|---|---|
| Node.js | **最低 22.16.0，建议使用 Node.js 24 LTS** |
| npm | 随 Node.js 安装，用于安装依赖和启动 |
| QQ / OneBot 实现 | 使用 snowluma 注入机器人登录的 QQ，或其他支持标准 OneBot v11 的实现 |
| 模型 | 一个可用的模型 API；支持 OpenAI 兼容、Anthropic、Gemini、Ollama 等协议 |
| 图片模型 | 可选，使用图片功能时需要真正支持视觉输入的模型 |
| 向量模型 | 可选，语义记忆检索需要可用的 embedding 模型 |

Windows 提供 `.bat` 启动文件；也可使用下面的 npm 命令。项目使用 Node 内置 SQLite，最低版本依据 [`DatabaseSync.isTransaction`](https://nodejs.org/api/sqlite.html#databaseistransaction) 的可用版本设置。安装后执行 `node -v` 和 `npm -v` 检查环境。

## 快速开始

### 1. 下载与启动

下载仓库源码并解压，或使用 Git 克隆。Windows 可双击 `start.bat`，首次启动会优先按锁文件执行 `npm ci` 安装依赖；安装失败时停止并保留错误信息。

命令行方式：

```powershell
npm ci
npm start
```

打开管理面板：**http://127.0.0.1:3081**。

发行版可以在未配置模型时启动后台，但此时不能正常进行模型回复。先配置模型和权限，再使用 QQ 测试。

### 2. 配置模型

在后台「模型接入」填写供应商地址与 Key，搜索模型，选中可用模型并设为默认。

在「模型接入」页面的「模型用途」区域按需配置：

| 用途 | 作用 |
|---|---|
| 主对话 | 生成聊天回复 |
| 情绪分析 | 分析消息情绪，调整回复语气 |
| 上下文压缩 | 对较早聊天生成摘要 |
| 记忆抽取 | 提取可保存的长期事实 |
| 向量化 | 为记忆建立向量并进行语义召回 |
| 图片理解 | 提取图片画面、文字和表情资料 |
| 语音识别（ASR） | 将录音转写成聊天文字 |
| 语音合成（TTS） | 按人格音色朗读回复 |

情绪、摘要和事实用途可继承默认聊天配置。向量化需要适配 `/embeddings` 等接口的 embedding 模型，不能把普通聊天模型当作向量模型。图片用途必须支持视觉输入；没有合适模型时机器人会说明无法读取图片。**ASR/TTS模型须明确指定，不能继承聊天模型。**供应商可以共用现有地址和Key，但必须提供对应语音接口；模型列表没有暴露语音模型时可手填ID。

也可以使用交互式配置向导：

```powershell
npm run init
```

后台供应商配置保存在 `config/providers.local.yaml`，向导可将密钥写入 `.env`。两者都已忽略。使用环境变量时，可复制 `.env.example` 为 `.env`，并在自己的供应商配置中设置匹配的 `apiKeyEnv`。不要把真实密钥写入要公开提交的 `config/providers.yaml`。

### 3. 配置管理员、群和指令权限

进入后台「权限」页面：

1. 将自己的 QQ 加入管理员列表。
2. 将允许使用机器人的群加入群白名单。
3. 按需设置用户白名单、黑名单。
4. 为每条指令选择权限范围并保存。

发行版的管理员、群白名单和用户白名单均为空。**空群/用户白名单表示不限制该范围；空管理员列表表示没有管理员。** 默认指令继承管理员限制，因此未设置管理员时，包括 `/help` 在内的管理指令都会被拒绝。

“仅用户白名单和管理员”是两者的并集：管理员不必重复添加到用户白名单；该模式下用户白名单为空时，仅管理员能使用该指令。黑名单和群限制继续生效。普通聊天的用户白名单与指令权限分别检查。

### 4. 连接 snowluma / OneBot v11

以snowluma为例，也可使用提供标准OneBot v11接口的实现。

在 snowluma 的适用运行环境中，**只对机器人登录的 QQ 进行注入**。管理员使用另一个 QQ 向机器人发送消息，不需要一起注入。

在 OneBot 实现端开启能提供 API 与事件的 **WebSocket 服务端**，让 QQ Agent 主动连接。默认：

```yaml
napcat:
  enabled: true
  mode: forward-ws
  url: ws://127.0.0.1:3001
  accessToken: ""
  selfId: 0
```

配置块名 `napcat` 是历史兼容名称，**不要求安装 NapCat**。连接方式是正向 WebSocket 客户端连接，不是 Agent 对外监听反向 WS。`selfId: 0` 表示从登录信息获取机器人账号。

- URL 填 OneBot 的实际地址；同机默认 `ws://127.0.0.1:3001`。
- 服务端设置 Token 时，Agent 的 `accessToken` 必须一致。
- 同时需要事件推送和 API 回执；只有事件通道时不能完成回复投递。
- 检查后台与日志中的连接、登录账号、API 就绪状态，确认实际账号是机器人 QQ。
- 手工修改连接配置后重启 Agent。

完成后，先私聊发送“你好”，再在允许的群里 @机器人测试。

## 发行版默认行为

| 设置 | 默认 |
|---|---|
| 私聊回复 | 开启，正常消息会触发 |
| 群聊 | 要求 @机器人；引用当前话题中已记录的机器人消息也可触发 |
| 主动插话 | **关闭** |
| 语音识别 / 人格语音回复 | **关闭**，先配置独立语音模型 |
| 定时提醒 | 开启，指令沿用权限限制 |
| 群聊日报 | **关闭**，后台启用后可使用 |
| 链接网页正文 | 开启，每轮默认最多3个公开链接 |
| 表情包发送 / 情绪自动补图 | 关闭 |
| 拟人分条发送 / 消息表情回应 | 关闭 |
| 普通回复引用开关 | 关闭；群内直接 @/引用机器人时仍明确引用触发消息 |
| 指令 | 未单独配置时继承管理员限制 |
| 后台 | 本机 `127.0.0.1:3081` |
| 模型供应商与各用途 | 空，需使用者设置 |

上下文、记忆和情绪功能会按配置在对话中工作。它们可能产生额外模型调用；向量检索只在配置可用 embedding 模型后生效。图片识别、摘要和记忆抽取也应根据自己的模型预算设置。

## 主动与被动回复

### 被动回复与对象归属

群内被动回复固定回应触发者，引用资料的原作者和最后发言者不会覆盖该对象。聊天输入携带发送者 QQ、消息 ID、@ 与引用关系；即使模型输出其他对象标记，也不能改变本轮被动回复的目标。

主动回复不默认 @最后发言者。模型明确选择有效成员时才 @和引用；对全群说话或对象不明确时不猜测。自然语言中的代词仍由模型生成，不保证每次表达都没有歧义。

### 统一聊天与图片窗口

每轮在会话队列实际执行、思考延迟结束后固定窗口：从上次已确认回复的最后片段之后，到本次生成流程开始前。允许的普通消息始终记录，窗口消息不受旧 `recentTurns` 或已摘要标记限制。

当前消息带图时，也会同时纳入窗口内其他人的图片；引用旧图只在当前话题内回看。切换话题后不会把旧话题原文和图片混入新话题。冻结后到来的消息保留在记录中，不混入在途模型请求。

模型容量仍有限：窗口最多扫描最新 2000 条记录，单轮最多加载 32 张图片，再按实际模型和图片尺寸计算预算。超长内容会裁剪并记录统计；图片优先保留当前请求及引用来源，未读取/未纳入的图片会标明，不能编造画面。旧 `recordAllMessages`、`recentImages`、`imageLookback` 保留配置兼容，不再用于限制统一窗口。

### 开启主动插话

在后台「概览」的功能设置中开启主动发言。模式包括 `probability`、`relevant`、`hybrid`、`off`。

- 数量路径只在距上次机器人发言的用户消息数达到 N 的整数倍时判断概率。
- 相关路径结合最新话题、明确追问、人格兴趣和允许使用的可信记忆，不额外调用模型进行相关性判断。
- 最小间隔、距上次机器人发言时间、安静时段、小时上限会共同限制发言；时间/次数限制为 0 时表示不限制，不表示关闭。
- 主动插话由新群消息触发，不会在群里没有新消息时定时自言自语。
- 普通群消息不会中断在途主动回复；同群重复主动候选跳过，不重复生成。需要被动回复的@、引用或关键词会抢占，切换/删除话题或关闭实例仍会取消旧任务。

发行版保留较保守的参数：每 8 条消息判断一次，基础概率 0.3、相关概率 0.7，主动间隔 10 分钟、距机器人发言 3 分钟，每群每小时最多 3 次，23:00～08:00 不主动发言。安静时段按运行机器本地时间判断。参数均可在后台调整。

## 人格、记忆与指令

### 编辑人格

后台「人格」页面可编辑：身份、语言风格、互动习惯、回答原则、情绪回应原则，以及预设对话和原始设定。旧 `systemPrompt` 继续兼容，和结构化设定一起生效，避免两者写入矛盾要求。

“感兴趣的话题”每行一项，可用 `|` 分隔同一话题的表达：

```text
编程|写代码|coding
摄影|拍照
天文|观星
```

最多 32 项，每行 2～100 字符。人格保存后热重载，后续主动相关性判断会使用新兴趣。

切换人格的两种方式：

```text
/persona gentle keep
/persona gentle new
```

`keep` 是默认方式，保留当前话题，旧人格回复作为历史资料；`new` 创建新话题，旧话题保留，可通过 `/topics` 切回。两种切换都会取消旧的在途任务。

### 指令表

| 指令 | 中文别名 | 作用 |
|---|---|---|
| `/help`、`/?` | — | 查看帮助 |
| `/persona [id] [keep\|new]` | `/人格` | 查看/切换当前人格 |
| `/personas` | `/人格列表` | 列出人格 |
| `/memory` | `/记忆` | 查看关于发送者自己的记忆 |
| `/forget <关键词>` | `/忘记` | 删除匹配的、允许访问的本人记忆 |
| `/emotion` | `/情绪` | 查看发送者情绪状态 |
| `/new [标题]` | `/新话题` | 新开话题，旧话题保留 |
| `/topics [序号]` | `/话题` | 列出或切换当前会话话题 |
| `/stats` | `/统计` | 查看机器人统计 |
| `/remind 10m 喝水` | `/提醒` | 创建定时提醒，也支持日期时间 |
| `/reminders` | `/提醒列表` | 查看当前会话待执行任务 |
| `/cancelremind <任务ID>` | `/取消提醒` | 取消自己的任务，管理员可取消本会话他人的任务 |
| `/daily`、`/daily at 21:00` | `/日报` | 本群最近24小时日报；定时日报仅管理员可设置 |

每条指令的权限均在后台「权限」设置，中文和英文别名共用权限。`/reset` 没有实现为可用管理指令，请使用 `/new` 管理新话题。

### 记忆与隐私

原始聊天、长期事实和摘要存于本机 `data/brain.db`。私聊/群聊和话题按范围组织，跨会话共享受 `memory.retrieval.crossScopeSharing` 控制。后台可检查、纠正事实，设置私密标记或删除记忆。主动相关性判断不会使用私密、失效或低置信度事实。

`/forget` 删除匹配的长期事实与相关索引，不等于清空原始聊天、摘要或日志。需要完整清理记录时，使用后台对应的数据管理功能，并核对保留范围。

## 阅读转发、链接和卡片

私聊可直接发送转发、链接或卡片并提问；群内可先分享，再@机器人问“总结刚才的内容”，也可引用旧消息。网页和卡片作为引用资料，里面的指令不执行、作者自述不记成分享者事实。网页仅读取公开静态文字；视频卡片提供标题、简介和链接。后台概览的“链接与卡片”组可调整读取开关、域名和资源上限。

详见[合并转发](docs/forward-messages.md)、[链接与卡片](docs/links-and-cards.md)。

## 语音、提醒与群聊日报

先在模型用途选择ASR/TTS供应商和模型，再在概览语音设置中选择协议、开启功能。QQ录音可能需要OneBot的`get_record`转换；返回本地WAV时需将转换缓存目录加入可信语音目录。后台人格编辑可设置独立音色、语速、模型和朗读风格。默认只在回复窗口包含语音时附加语音，也可设为每次回复；文字回复始终保留。

提醒可以使用`/remind 10m 喝水`或明确文字“10分钟后提醒我喝水”；群内自然提醒需@机器人。后台“提醒与日报”可创建、查看、取消及检查执行记录。群聊日报使用“摘要”模型，需先在后台启用；只总结目标群已记录的最近24小时内容。语音转写不会自动执行管理指令或创建提醒。

详见[语音与定时任务配置](docs/voice-and-scheduled-tasks.md)。

## 语音参数怎么填写

入口分为三处：**模型接入 → 模型用途**选ASR/TTS供应商和模型；**概览 → 语音**填写接口和通用参数；**人格 → 编辑 → 人格语音**填写各人格音色。先完成参数，再开启ASR/TTS。供应商必须提供语音接口，普通聊天模型不能代替语音模型。

### 1. 供应商、模型和认证

| 参数/位置 | 怎么填 |
| --- | --- |
| 供应商Base URL | 填服务商API基础地址，例如`https://api.openai.com/v1`。不要填到`/audio/speech`或`/audio/transcriptions`。自建服务填它的API基础地址。 |
| 供应商API Key | 在模型接入里填写自己的密钥；不要写进人格、接口路径、额外JSON或公开配置。 |
| 供应商额外请求头 | 通常留空；接口需要自定义认证时按服务商填写。程序对OpenAI/custom使用Bearer Key，对Gemini使用`x-goog-api-key`。若custom服务使用其他认证头，将供应商Key留空并在请求头中配置。 |
| ASR供应商 `llm.roles.asr.provider` | 下拉选择提供识别服务的供应商；留空继承默认供应商。 |
| ASR模型 `llm.roles.asr.model` | 填服务端真实识别模型ID，必须明确指定；模型未出现在列表中可手填。 |
| TTS供应商 `llm.roles.tts.provider` | 下拉选择提供合成服务的供应商，可与ASR不同；留空继承默认供应商。 |
| TTS模型 `llm.roles.tts.model` | 填真实合成模型ID，必须明确指定；人格可以单独覆盖。 |

下面是官方接口的**填写示例**，实际可用模型和音色以自己的账号权限及服务商文档为准：

| 项目 | OpenAI示例 | 硅基流动示例 |
| --- | --- | --- |
| Base URL | `https://api.openai.com/v1` | `https://api.siliconflow.cn/v1` |
| ASR模型 | `gpt-4o-mini-transcribe` | 从服务端选择支持`/audio/transcriptions`的识别模型 |
| TTS模型 | `gpt-4o-mini-tts` | `FunAudioLLM/CosyVoice2-0.5B` |
| ASR/TTS协议 | `openai` | `openai` |
| 默认音色 | `coral` | `FunAudioLLM/CosyVoice2-0.5B:alex` |
| TTS响应形式 | `binary` | `binary` |
| 音频格式 | `mp3` | `mp3` |
| TTS风格字段名 | `instructions`，使用支持此参数的模型 | 不支持独立风格参数时设为空 |
| 额外请求JSON | `{}`起步 | `{}`起步 |

依据：[OpenAI识别](https://developers.openai.com/api/docs/guides/speech-to-text)、[OpenAI合成](https://developers.openai.com/api/docs/guides/text-to-speech)、[硅基流动合成](https://docs.siliconflow.cn/docs/userguide/capabilities/text-to-speech)。这些示例不需要改变现有聊天模型配置。

### 2. 通用参数与开关

| 参数 | 默认值 | 怎么填及效果 |
| --- | --- | --- |
| 启用语音理解 `speech.asr.enabled` | 关闭 | 配好ASR后开启；不需要识别录音时保持关闭。 |
| 识别允许群内所有语音 `speech.asr.groupAll` | 关闭 | 关闭时只识别需要回复的群语音；开启后识别已通过群/用户准入的群语音，供后续上下文使用，但不强制回复。私聊符合准入时会识别。 |
| 启用人格语音回复 `speech.tts.enabled` | 关闭 | 配好TTS后开启。先投递正常文字，再附加语音；合成或发送失败保留文字。 |
| 语音回复场景 `speech.tts.mode` | `on-audio` | `on-audio`：回复窗口包含录音时附加语音；`always`：普通主动/被动模型回复都附加语音。管理指令的固定回复不经过此朗读流程。 |
| 调用超时 `speech.timeoutMs` | `30000` | 单位毫秒，30000=30秒；允许1000～120000。服务较慢时可设60000。 |
| 音频大小上限 `speech.maxBytes` | `20000000` | 单位字节，约20MB；允许1024～25000000。服务商上限更低时按其限制降低。不是录音时长。 |
| 可信语音目录 `speech.allowedDirs` | 空列表 | 填OneBot `get_record`返回的WAV文件实际所在目录，例如`D:/QQAudio/cache`；多个目录用逗号分隔。HTTP/base64音频通常无需此项。不要填机器人QQ号或OneBot WS地址。 |
| 最大朗读字数 `speech.tts.maxChars` | `1500` | 允许50～4000；超出上限仅保留文字，不截取一半朗读。长回复可先用300～800。 |
| 默认音色 `speech.tts.voice` | `alloy` | 填服务商音色ID，不是“猫娘”“温柔”等人格名称；例如`coral`或服务商要求的完整`模型:音色`ID。人格音色为空时使用此值。 |
| 合成音频格式 `speech.tts.format` | `mp3` | 可选`mp3`、`wav`、`opus`；需服务商支持。先用mp3。Gemini原生音频不使用这个OpenAI格式字段，PCM响应会转换为WAV。 |
| 默认朗读风格 `speech.tts.instructions` | 空 | 可写“用自然、温柔的中文语气朗读”；最多1500字。需接口支持对应参数；不支持时把TTS风格字段名设为空。 |

QQ录音常为SILK，需要OneBot转换为WAV。先确认实现支持`get_record`，再把其返回的实际缓存目录加入可信目录；目录允许不等于具备转换能力。TTS发送还需要OneBot支持`can_send_record`和`record`消息。

目录包含空格时，当前后台列表输入会按空白分隔，请直接在自己的`config/app.local.yaml`用YAML数组填写并重启，例如：

```yaml
speech:
  allowedDirs:
    - 'D:/QQ Audio/cache'
```

程序最多同时处理4个语音任务，一条消息最多识别2段录音；TTS音频还受OneBot发送缓冲大小限制。转写文字不会自动执行`/forget`等指令，也不会直接创建提醒。

### 3. ASR识别接口参数

| 参数 | 默认值 | 怎么填 |
| --- | --- | --- |
| 协议 `speech.asr.protocol` | `auto` | `auto`按供应商协议选Gemini或OpenAI兼容；明确是`/audio/transcriptions`时选`openai`；Gemini音频输入选`gemini`；其他HTTP格式选`custom`。Anthropic/Ollama供应商不能通过auto直接获得语音能力。 |
| 端点路径 `speech.asr.path` | 空 | OpenAI兼容留空会使用`/audio/transcriptions`；基础地址已有`/v1`时不要再填`/v1/audio/transcriptions`。自定义服务可填`/recognize`或完整HTTP URL。Gemini原生自动生成端点，此项不使用。 |
| 音频编码 `speech.asr.encoding` | `multipart` | 自定义接口接收文件上传选`multipart`；接收base64 JSON选`base64-json`。OpenAI兼容固定使用multipart，Gemini原生固定使用inlineData。 |
| 模型字段 `speech.asr.modelField` | `model` | 填服务端接收模型ID的请求字段名，例如`model`或`engine`；留空省略。 |
| 文件字段 `speech.asr.fileField` | `file` | multipart时填文件字段名，如`file`或`recording`，不能为空；base64-json时该字段装base64字符串，可留空后改用额外JSON嵌套模板。 |
| 响应字段路径 `speech.asr.responsePath` | 空 | 返回`{"text":"你好"}`时留空；返回`{"result":{"transcript":"你好"}}`时填`result.transcript`。纯文字响应也留空。Gemini原生自动读取文字parts，不使用这个映射。 |
| 额外请求JSON `speech.asr.extra` | `{}` | 填服务端额外参数的JSON对象，如`{"language":"zh"}`，需接口支持。base64-json可用嵌套模板；multipart按表单参数发送固定值，不替换模板变量。Gemini原生请求不使用此项。 |

**ASR中若显示“文字字段、音色字段、speedField、instructionsField、formatField”，它们是共用配置项，当前识别请求不使用，可保持默认。** ASR始终按文字/JSON解析结果，不需要配置TTS的binary/base64/url响应形式。


以下共用字段保留默认即可，当前ASR不会发送它们：

| 共用配置项 | 默认值 | 当前作用 |
| --- | --- | --- |
| `speech.asr.textField` | `input` | 识别不需要输入文字字段 |
| `speech.asr.voiceField` | `voice` | 识别不选择音色 |
| `speech.asr.speedField` | `speed` | 识别不发送朗读语速 |
| `speech.asr.instructionsField` | `instructions` | 识别不发送TTS风格提示 |
| `speech.asr.formatField` | `response_format` | 识别不发送此格式字段；需要识别响应格式时按接口文档放进ASR额外JSON |
| `speech.tts.fileField` | `file` | 合成输入是文字，不上传录音文件 |

### 4. TTS合成接口参数

| 参数 | 默认值 | 怎么填 |
| --- | --- | --- |
| 协议 `speech.tts.protocol` | `auto` | OpenAI兼容选`openai`；Gemini音频输出选`gemini`；其他HTTP格式选`custom`。必须搭配支持音频输出的模型。 |
| 端点路径 `speech.tts.path` | 空 | OpenAI兼容留空使用`/audio/speech`；自定义可填`/synthesize`或完整HTTP URL。Gemini原生自动生成端点，此项不使用。 |
| 响应形式 `speech.tts.responseType` | `binary` | 接口直接返回MP3/WAV/Opus字节选`binary`；JSON内放base64选`base64`；JSON内放音频下载URL选`url`。Gemini原生自动解析音频，不使用此项。 |
| 响应字段路径 `speech.tts.responsePath` | 空 | binary留空；JSON默认读取`audio`，返回`{"data":{"audio":"..."}}`时填`data.audio`。必须指向base64字符串或HTTP音频URL。 |
| 模型字段 `speech.tts.modelField` | `model` | 服务端模型字段名；例如`model`或`engine`。 |
| 输入文字字段 `speech.tts.textField` | `input` | 服务端要朗读的文字字段名；若文档写`text`，这里填`text`。 |
| 音色字段 `speech.tts.voiceField` | `voice` | 音色字段名；例如`voice`、`speaker`、`speaker_id`。 |
| 语速字段 `speech.tts.speedField` | `speed` | 服务端支持语速时填其字段名；不支持时设为空。语速数值在“人格语音”中填。 |
| 风格字段 `speech.tts.instructionsField` | `instructions` | 接口支持风格提示时保留或改成服务端字段名；不支持时设为空，避免发送无效参数。 |
| 格式字段 `speech.tts.formatField` | `response_format` | 服务端接收输出格式的字段名；若写`format`则填`format`；不支持时设为空。 |
| 额外请求JSON `speech.tts.extra` | `{}` | 填自定义参数或嵌套请求模板。标准字段会在模板之后写入；嵌套格式应把不需要的平铺字段名设为空。Gemini原生不使用额外JSON或上述字段映射。 |

TTS当前发送JSON请求，文件字段与音频编码设置不参与合成。**请求字段名只是一级键名**，填写`request.text`不会自动创建嵌套对象；嵌套对象请用额外JSON。响应字段路径才支持`data.audio`这样的点路径。

### 5. 人格语音参数及继承顺序

| 人格参数 | 默认值 | 怎么填及继承规则 |
| --- | --- | --- |
| 允许语音 `voice.enabled` | 开启 | 仅允许这个人格使用全局TTS；全局TTS关闭时仍不会发送语音。 |
| 覆盖供应商 `voice.provider` | 空 | 填“模型接入”里已有供应商的标识，不是服务商网址；留空使用TTS用途供应商。 |
| 覆盖模型 `voice.model` | 空 | 填该供应商支持的真实TTS模型ID；留空使用TTS用途模型。更换人格供应商时，通常也要填写匹配模型。 |
| 音色ID `voice.voice` | 空 | 填该模型支持的音色ID；留空使用全局默认音色。不能直接填写人格ID来获得对应声音。 |
| 语速 `voice.speed` | `1` | 1=正常；可先试0.9或1.1。项目允许0.25～4，但服务端可能有更窄范围，需遵守服务端限制。Gemini原生不发送数值speed，可在风格描述中表达语速。 |
| 朗读风格 `voice.instructions` | 空 | 例如“用轻松、温柔的中文语气朗读”；留空使用全局风格。Gemini将其加入朗读提示，其他接口需支持风格字段。 |

供应商和模型各自独立继承：人格覆盖 → TTS用途 → 默认供应商；**TTS模型没有聊天模型回退**。音色与风格为人格优先、全局其次；语速使用人格数值。

### 6. 自定义接口填写示例

假设ASR收`{"request":{"audio":"base64...","engine":"模型ID"}}`，返回`{"result":{"transcript":"识别文字"}}`：协议选custom、编码选base64-json、路径按服务端填写，模型字段和文件字段设为空，响应路径填`result.transcript`，额外JSON填：

```json
{"request":{"audio":"$audioBase64","engine":"$model","mime":"$mimeType"}}
```

假设TTS收嵌套请求，返回`{"data":{"audio":"base64..."}}`：协议选custom，响应形式选base64，响应路径填`data.audio`；模型/文字/音色/语速/风格/格式这些平铺字段名都设为空，额外JSON填：

```json
{"request":{"model":"$model","text":"$text","speaker":"$voice","speed":"$speed","format":"$format"}}
```

可用变量为`$model`、`$audioBase64`、`$mimeType`、`$text`、`$voice`、`$speed`、`$instructions`、`$format`，按识别/合成请求使用对应变量。只有整个字符串等于变量名时才替换；`$speed`保留数字类型，`前缀$text`不会拼接替换。不要填写JavaScript表达式。

### 7. 填完后的检查顺序

1. 确认ASR/TTS供应商启用，且选择的是语音模型，Key有权限。
2. ASR开启后，私聊发送一段短录音；失败时检查日志中的get_record转换、可信目录、HTTP状态和响应字段。
3. TTS先选on-audio，音色选服务商支持的ID，语速1，额外JSON为`{}`；服务不支持风格/speed时将相应字段名设为空。
4. 已收到文字但没有语音时，检查人格允许语音、全局TTS、场景模式、文本长度及OneBot语音发送能力。
5. 提示响应字段不存在时核对binary/base64/url和字段路径；“非支持音频”常见原因是服务返回了错误JSON或尚未转换的SILK。

后台保存后通常对后续请求生效；手工修改配置需要重启。服务需要专用签名、实时WebSocket或异步轮询时，请通过兼容HTTP网关接入。


## 无真实 QQ 的调试与测试

### 模拟 OneBot

Windows 双击 `start-mock.bat`，或执行：

```powershell
npm run mock:onebot
```

另开终端执行 `npm start`。在模拟服务端输入：

- 普通文字：模拟群里 @机器人。
- `/p 你好`：模拟私聊。
- `/g 你好`：模拟普通群聊消息。

Mock 默认使用 3001；端口被占用时可能改为 3002，请根据终端提示设置 `napcat.url`。模拟的 QQ/群号还需要满足自己的权限配置。实际模型回复仍要求先配置模型 API。

### 自动测试与构建

```powershell
npm ci
npm test
npm run build
```

`npm test` 执行类型检查、离线回归和隔离的本地 Mock/API 测试，不发送真实 QQ 消息、不调用真实模型。其他旧阶段脚本可能依赖模型/运行配置，常规验证使用上述命令即可。

也可以只检查类型或专项：

```powershell
npm run typecheck
npm run test:command-permissions
npm run test:persona-context
npm run test:proactive-relevance
npm run test:reply-window
npm run test:forward-messages
npm run test:speech
npm run test:scheduled-tasks
npm run test:links-cards
```

构建后可使用 `node dist/src/index.js` 启动；保留 `src/web/panel.html`，编译产物不会单独包含该页面。

## 更新已有实例

1. 停止 Agent。
2. 备份 `data/`、`.env`、本地配置和自定义人格。
3. 更新源码、`package.json`、锁文件及脚本，保留自己的运行配置和数据。
4. 执行 `npm ci`，再运行测试和构建。
5. 重启并检查账号、模型和权限设置。

旧数据库升级前会自动生成迁移备份。本版本使用 schema v5；更新程序本身不会代替你删除原始数据。需要回滚代码时，同时考虑数据库版本与迁移备份。

## 目录与公开发布

```text
src/                       Agent、OneBot、模型、记忆与后台源码
scripts/                   配置向导、Mock 和测试
config/app.yaml            发行版通用配置
config/providers.yaml      空供应商列表与示例
config/personas/            人格定义
config/stickers/README.md   表情包使用说明
.env.example               环境变量模板
README.md                  本说明
package.json / lock        依赖与 npm 命令
```

运行后产生的 `data/`、`logs/`、`runtime/`、`dist/`、`node_modules/`，以及 `.env`、`*.local.yaml`、个人表情收藏和开发工具会话都不应提交。`.gitignore` 与 npm 打包规则已排除它们。

源码包可在保持发行版空白配置时生成：

```powershell
New-Item -ItemType Directory -Force runtime/releases
npm pack --pack-destination runtime/releases
```

npm生成的包不附带 `package-lock.json`；从该包解压运行时使用 `npm install`，GitHub源码或完整源码ZIP仍使用 `npm ci`。npm 包中使用明确文件白名单，不包含运行数据库、日志、工具会话或 Git 历史。若已经在发行目录设置了自己的 QQ、群号或模型供应商，先恢复通用配置并复核内容，再发布。公开前选定并加入 `LICENSE`，说明使用与修改授权；此目录尚未附许可证。

发布代码时先审查 Git 待提交清单；本说明不会自动创建远程仓库或推送 GitHub。更新摘要见 [发行版更新记录](docs/release-notes.md)。

## 常见问题

**后台能打开，但机器人不回复**

检查是否设置默认模型、供应商 Key 是否可用、OneBot 是否同时提供事件和 API、登录账号是否正确、用户/群是否被权限拒绝。群里普通消息在默认配置下不会触发回复，需要 @或引用机器人。

**`/help` 或切换人格被拒绝**

先在后台添加管理员，再检查该指令的独立权限。群白名单与用户黑名单仍会限制指令。

**图片只剩占位符或提示看不到**

确认视觉模型支持图片、媒体来源能读取、预算足够。过期 QQ 图片、本地目录限制或识别失败都会退回说明缺失的文本回复。不能仅通过把模型能力改为“视觉”让纯文本模型获得看图能力。

**向量检索没有生效**

配置 embedding 模型并确认其向量接口可用；未就绪或失败时会退回关键词检索。普通聊天模型不自动成为可用的向量模型。

**主动插话没有发生**

发行版默认关闭。开启后仍受数量机会点、相关性、概率、安静时段、间隔和每小时上限限制。普通群消息不取消在途生成；被动触发、话题操作和实例关闭仍会取消。查看“主动任务结束”中的 `reason`、`deliveryState`、`outcome`；用 `turnId` 对照“主动任务已入队”“主动任务开始模型生成”“主动任务开始投递”，候选或入队日志不表示已发送。

**端口占用或 OneBot 一直重连**

核对 `napcat.url`、服务端端口和 Token，避免同时启用占用相同端口的真实服务与 Mock。连接失败不会阻止本地后台启动。

### 双击脚本出现碎片化命令错误

如果出现 `'-click'`、`'mis-decode'`、`'anel:'` 等“不是内部或外部命令”，说明旧批处理的换行被转换成了 LF。请使用本次修复后的 `start.bat`、`start-mock.bat` 和 `test.bat`，保持 ASCII、无 BOM 和 CRLF；不需要改动自己的数据库或模型配置。

仓库的 `.gitattributes` 使用 `*.bat -text` 和 `*.cmd -text`，保留 Git 对象中的原始 CRLF 字节，使 GitHub Download ZIP 和 Git 克隆都能得到可执行的批处理。[Git 属性说明](https://git-scm.com/docs/gitattributes)

如果你维护已有 GitHub 仓库，请一起提交并推送这三个脚本和 `.gitattributes`。只修改换行属性而不重新提交脚本，旧归档不会自动修复。

在更新脚本前，也可以打开命令提示符，进入项目目录，手动执行 `npm ci` 和 `npm start`。如果命令提示符本身也提示找不到 npm，请安装满足要求的 Node.js 并重新打开终端。

### 启动日志中文乱码

如果日志出现“鍚姩”“鏁版嵁”等乱码，终端通常正在用代码页936解释UTF-8。新版三个批处理会在安装和启动前执行 `chcp 65001 >nul`。替换对应启动脚本即可，保留自己的配置和数据库。

直接在命令提示符运行 npm 时，先切换编码：

```cmd
chcp 65001
npm start
```

若中文正常但emoji显示为方框，属于字体显示问题，可用Windows Terminal或支持相应字符的字体。


## 日报和表情包排查

日报生成使用“摘要”用途模型。后台“提醒与日报 → 日报模型超时（毫秒）”可设置预算：`0`继承`llm.request.timeoutMs`（默认120000），或填写1000～600000。例如模型较慢时可填180000。明确未投递的失败每60秒重试，最多三次；间隔从当次失败完成时计算。结果未知不自动重发，三次日报生成失败后继续次日计划。查看“开始生成群聊日报”“定时任务执行未成功”和“定时任务已确认投递”，可区分生成和发送问题。

直接@机器人或在私聊说“发个表情包”“给我一个开心的表情包”会提供可用候选；模型未加标记时补发一张已筛选图片。否定请求、转发/卡片/网页资料、主动插话和禁用状态不走明确请求兜底；图片仍受数量和冷却限制。若希望按情绪自动发，后台开启自动发送；“命中情绪”留空表示任何情绪，填写后按指定情绪匹配（兼容旧字段列表）。仍需开启情绪分析，并受最低强度、发送概率、会话冷却、每次图片上限及候选筛选限制；开启自动发送后，模型点名和自动补图统一按配置概率判定一次并遵守会话冷却；结合回复语境筛选，候选不足时可从库中选匹配已识别情绪的图片，不随机发无关图片。明确请求仍直接满足。

图片使用标准file URI，明确拒绝才退化为base64；只有可靠QQ消息ID才确认成功，未知结果不重复发送。协议参考：[OneBot v11图片消息段](https://github.com/botuniverse/onebot-11/blob/master/message/segment.md#图片)。升级保留原有任务记录，不强制重放历史失败任务；即时日报可由有权限的用户发送`/daily`重新生成。

## 输出 token 预算与诊断日志

「概览 → 功能开关 → Token 预算」可分别设置回复、图片理解、表情识图、情绪、记忆抽取、摘要和日报预算。每项显示填 0 时的原预算及当前继承/自定义状态；回复/摘要读取当前配置，回复提示人格覆盖，图片预算显示动态计算规则。

`GET /api/token-budgets` 查询，`PATCH /api/token-budgets` 部分更新，例如 `{"budgets":{"chat":4096,"vision":4096,"sticker":3000}}`。0 保持原预算，非零限制每次生成（含重试）的输出 token；支持 0～131072 的整数，仍受实际模型窗口和独立超时限制。保存后热生效。达到输出上限通常返回截断结果，JSON 截断才可能导致解析失败。详见 [Token 预算说明](docs/token-budgets.md)。

模型、视觉、情绪/记忆辅助任务、OneBot、语音、表情包、网页转发及后台任务的错误日志补充类型、原因链、堆栈、错误码、阶段、模型、耗时和预算；保留原回退和重试，并脱敏认证信息、签名 URL 和图片数据。详见 [日志诊断说明](docs/log-diagnostics.md)。

本批代码需重启已运行的 Agent 才会加载；升级保留已有配置、人格、收藏图片和数据，未配置的新 token 预算默认为 0。
