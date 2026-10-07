# 错误日志诊断说明

日志增强保留现有业务行为：不调整配置、超时、概率、重试次数、回退内容、消息投递和接口返回。既有日志文字、`err`/`reason` 字段继续保留；新增诊断字段用于查明原因。

| 字段 | 含义 |
| --- | --- |
| `mod` / `phase` | 模块及失败阶段，如 `vision-description`、`response`、`transcription` |
| `scope` / `turnId` | 会话及回复轮次；只在调用方已有这些信息时记录 |
| `provider` / `model` / `purpose` | 模型供应商、模型及用途 |
| `timeoutMs` / `elapsedMs` / `remainingMs` | 等待预算、已耗时、剩余预算；按所在调用层记录 |
| `failureKind` | 辅助任务的 `timeout`、`cancelled` 或 `error`，用于区分统一降级的触发原因 |
| `errorKind` | 从原始异常识别出的超时、取消、认证、限流、网络或返回格式错误 |
| `error` | 有界错误快照，包含名称、消息、堆栈、原因链及可用错误码 |
| `action` / `echo` / `status` / `retcode` / `outcome` | OneBot 动作、对应请求及投递结果；不记录动作参数和消息正文 |
| `attempt` / `waitMs` / `retryMs` | 当前尝试和原有重试等待时间 |
| `fallback` | 继续采用的回退路径，例如 `text`、`rule`、`keyword` |

视觉识别原有「视觉分析超时或失败」仍保留，但同一条日志会附上 `failureKind`、原始 `error`、模型、图片数量、视觉预算和耗时。如果辅助层因超时主动取消请求，`failureKind: timeout` 是触发原因，底层 `errorKind: cancelled` 则表示请求已被取消，两者并不矛盾。

模型调用每次失败都会记录用途、尝试编号和错误状态。OneBot 发送及等待响应失败分别记录阶段；结果未知仍不重复发送。图片来源逐个读取失败记录在 debug 级别，全部来源失败时会汇总原始原因到 warn。语音、合并转发、网页、表情识图、摘要、记忆、后台和定时任务保留原回退并补充诊断。管理接口异常记录方法和路径，错误状态记录耗时，不记录请求体、查询参数或认证头。

错误快照最多保留四层原因、十二行堆栈和五个聚合错误。不复制错误对象中的请求配置或响应正文。结构化字段和错误消息内的常见密钥、Bearer、Cookie、签名 URL、base64 图片数据会脱敏；循环对象、异常 getter 不会导致诊断失败。

新增 `npm run test:logging`，并加入完整离线回归。覆盖原始错误保留、分类、脱敏、循环错误、辅助回退与诊断回调异常、OneBot 未知结果不重发，以及视觉 API/格式/超时三类失败后继续文本回复。

本次完整离线回归、隔离阶段一和面板回归、类型检查及构建均通过。测试输出在 `runtime/log-diagnostics/offline-test-output.txt` 和 `runtime/log-diagnostics/isolated-test-output.txt`。测试使用隔离夹具，未调用真实模型、发送真实 QQ 消息或重启机器人。
