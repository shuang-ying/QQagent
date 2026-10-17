# 内置 SnowLuma 与 Web 终端

更新日期：2026-10-17。

## 使用

1. 启动 QQ Agent，打开原有管理面板，选择左侧 **SnowLuma**。
2. 第一次使用先点击 **安装内置组件**。页面在后台从 **SnowLuma 官方 GitHub 发布页**下载固定版本的完整包与同版本源码，校验 SHA256 后解压，无需手动运行 pnpm，也无需安装 SnowLuma 的 npm 依赖。
3. 安装完成后点击 **启动 SnowLuma**。
4. 从终端输出查看首次登录密码，在下方官方界面完成登录、使用条款确认与 QQ 接入。
5. 配置 SnowLuma 的 OneBot 连接，使其与页面显示的 Agent 连接地址一致。
6. 不需要持续打开命令行窗口。刷新或离开页面不会停止进程；需要停止时点击 **停止**。

发行版仓库**不包含** SnowLuma 的源码或二进制文件：安装时由你的机器直接从上游官方发布页下载，发行包与 npm 包中都没有这些文件（见下文「上游与许可」）。因此首次安装需要能访问 `github.com`；离线环境请按同一节的手动步骤准备官方包。

不会自动改写 Agent 的 OneBot 地址、认证、模型或既有账号资料。此前单独运行的另一个 SnowLuma 不会被接管或停止，本页面只管理自己启动的实例。


## 保持分离

```text
浏览器 → Agent 管理接口 → 独立 SnowLuma 子进程
       → 专用受鉴权代理 → SnowLuma 原有 WebUI
Agent OneBot 客户端 ← OneBot → SnowLuma
```

Agent 仍负责回复、模型、人格、记忆与主动发言；SnowLuma 仍负责 QQ 协议、OneBot 和自己的界面。官方代码不编入 Agent 的 TypeScript 构建、不导入回复流程，而由另一个 Node 进程运行。

Agent 正常退出时关闭代理、停止受管 SnowLuma。父进程意外退出导致 stdin 管道断开时，runner 也会请求 SnowLuma 收尾；超时只清理自己启动的进程。异常退出会报告退出码，不无限自动重启。Agent 重启后默认需要重新点击启动。

QQ 自动接入遵循 SnowLuma 自己保存的设置，首次安装默认手动接入。进程及 WebUI“运行中”不代表 QQ 已登录或 Agent OneBot 已连接，实际连接状态仍在两个项目原有界面查看。

## 目录

| 路径 | 内容 | 发布范围 |
|---|---|---|
| `src/snowluma/` | 本项目的安装、进程管理、鉴权代理及固定版本清单 | 提交 Git |
| `scripts/snowluma-runner.mjs` | 独立进程入口、父进程退出收尾 | 提交 Git |
| `runtime/snowluma/distribution/app/` | 原样官方运行包，含 Node、JS、WebUI、原生组件及使用条款 | 不提交、不打包 |
| `runtime/snowluma/distribution/source/` | 完整原始源码副本，保留上游声明 | 不提交、不打包 |
| `runtime/snowluma/distribution/LICENSE` | 上游完整源码许可 | 随本地组件保留 |
| `runtime/snowluma/distribution/installation.json` | 版本、平台、源码提交与校验信息 | 本地安装状态 |
| `runtime/snowluma/state/` | 独立工作目录：账号配置、聊天存储、日志、用户设置 | 私人运行数据 |
| `runtime/snowluma/downloads/` | 已验证的官方包及源码归档 | 本地下载缓存 |

安装先写临时目录，验证完成后原子发布。失败或取消不会覆盖账号数据，已有安装目录不自动覆盖。当前没有删除数据或强制升级按钮。

Windows 使用系统 tar 检查归档路径，再通过 PowerShell `Expand-Archive` 解压 ZIP，兼容源码 ZIP 的符号链接条目；原始 ZIP 保留并验证固定 SHA256。Linux 使用系统 tar。支持 Windows x64、Linux x64、Linux arm64；其他平台明确提示，不影响 Agent 原有功能。

## 终端与内嵌页面

每秒按增量游标读取标准输出、标准错误和管理事件。后端保留最多 2000 行、每行最多 4096 字符，每次返回最多 250 行；前端文本也限制大小。清空屏幕只清除显示，不删除文件日志。UTF8 分片正确解码，移除终端控制字符，并使用 `textContent` 显示，不执行日志中的 HTML。

上游默认禁止 iframe。专用代理不改写官方文件，保留资源路径、登录与接口，把代理响应的嵌入限制调整为只允许已授权的 Agent 页面。真实 HTML、脚本、登录和 SSE 状态流可在内嵌界面运行，远程浏览器不会误连接到自己机器上的 localhost。

SnowLuma 后端和专用代理使用自动分配端口；后端仅监听服务器回环，代理监听范围沿用 Agent 面板。局域网防火墙需允许该代理端口；当前不是把 SnowLuma 的全部路由合并进 Agent 同一个端口。

## 鉴权

- 所有 `/api/snowluma/*` 接口受现有 Agent 管理鉴权保护，控制操作拒绝跨站 Origin。
- 内嵌代理由已鉴权接口签发随机 8 小时会话，使用 HttpOnly、SameSite=Strict Cookie；不接受查询参数 Token。
- SnowLuma 自己的登录 Token 独立使用，不以 Agent Token 替代。首次 EULA/隐私确认仍由用户在原页面完成。
- 终端可能显示初始密码及账号输出，仅向有面板访问权限的人展示。账号、日志、归档和上游组件均排除于 Git/npm 发布包。
- API 不接受任意程序路径、下载地址或 Shell 命令。

| 接口 | 功能 |
|---|---|
| `GET /api/snowluma/status` | 安装、版本、进程、错误、目录及 Agent OneBot 地址 |
| `GET /api/snowluma/terminal?after=序号` | 增量日志 |
| `POST /api/snowluma/install` | 后台安装，返回 202；页面轮询进度 |
| `POST /api/snowluma/start` | 幂等启动并等待 WebUI 就绪 |
| `POST /api/snowluma/stop` | 停止进程，也可取消安装或启动 |
| `POST /api/snowluma/session` | 设置代理会话 Cookie，返回代理端口 |

## 上游与许可

固定版本：[SnowLuma v1.14.22](https://github.com/SnowLuma/SnowLuma/releases/tag/v1.14.22)。源码提交：`87527cb7641a5a42f8f0efb73cb066102e004dee`。归档和 SHA256 清单见 [release.ts](../src/snowluma/release.ts)，不会每次启动自动更新到上游最新版本。

### 结论：不内置、不打包上游代码

上游采用 [SnowLuma 源码可见非商业许可](https://github.com/SnowLuma/SnowLuma/blob/v1.14.22/LICENSE)（SnowLuma Source-Available Non-Commercial License），**不是** OSI 定义的开源许可；随包的原生组件（`snowluma-*.node` / `.dll` / `.so`）另有专有条款（EULA 第 5 条）。与本项目直接相关的限制是：

| 条款 | 内容 | 对本项目的影响 |
|---|---|---|
| LICENSE 3(d) | 公开发布修改版或衍生版须事先取得著作权人书面许可 | 不能提交或分发改动过的上游源码 |
| LICENSE 4(a) | 未经书面授权禁止任何商业使用 | 本项目及其发行包不得商用 |
| LICENSE 4(b) | 未经书面授权，不得基于本软件开发、发布或分发另一个项目 | 本项目的接入方式限定为公开的 OneBot v11 接口，不包含上游代码 |
| LICENSE 5 / EULA 5.4 | 原生组件为专有组件，不得复制、修改、单独再分发；并入第三方安装包或 Docker 镜像、通过自动化脚本部署须事先取得书面授权 | 不把原生组件放进 Git 仓库、npm 包或发行 ZIP |

因此**发行版与 npm 包都不包含任何上游源码、二进制、归档或修改版本**，`runtime/`（含 `runtime/snowluma/**`）全部位于 `.gitignore` 与 `.npmignore` 中。仓库里只有本项目自己写的管理代码（`src/snowluma/`、`scripts/snowluma-runner.mjs`）和固定版本、校验值的清单。面板的安装按钮做的是「从上游官方发布页下载到你自己的机器」，既不复制也不转发上游文件；首次登录时的 EULA 与隐私确认仍由用户在上游自己的页面完成。

若你要公开分发整包、做成商业产品或代部署服务，请先按上游条款取得书面授权（联系方式见上游 LICENSE），或只保留上文「方案 A」的 OneBot 连接方式而完全不分发上游组件。

### 手动安装（离线或内网）

自动安装需要能访问 `github.com`。不能联网时按下面步骤自备官方包，目录与文件名不要改：

1. 从 [v1.14.22 发布页](https://github.com/SnowLuma/SnowLuma/releases/tag/v1.14.22) 下载与你的平台对应的包：`SnowLuma-v1.14.22-win-x64.zip`、`SnowLuma-v1.14.22-linux-x64.tar.gz` 或 `SnowLuma-v1.14.22-linux-arm64.tar.gz`。
2. 自行核对完整性。Windows：`certutil -hashfile SnowLuma-v1.14.22-win-x64.zip SHA256`；Linux：`sha256sum 上面的文件名`。应与下表一致：

   | 文件 | SHA256 |
   |---|---|
   | `SnowLuma-v1.14.22-win-x64.zip` | `c8076ba2fbcdc19afeb8e8bf9b2956eaab3605e5fa4618c4db702749ae501681` |
   | `SnowLuma-v1.14.22-linux-x64.tar.gz` | `cd663a165caf012e08e6c303de69293fa7ccdc3950985b49bb254af9d4d91b98` |
   | `SnowLuma-v1.14.22-linux-arm64.tar.gz` | `203dac6497c3ee13fa5bb9d0f5d6e13cce3b33ebabb9e8089b36da2913c78e4b` |

3. 解压到 `runtime/snowluma/distribution/app/`，确认 `runtime/snowluma/distribution/app/index.mjs` 存在。这一步就是上游包本身的目录结构，不要裁剪文件。
4. 在同级写 `runtime/snowluma/distribution/installation.json`，版本、平台与架构必须与当前机器一致（`win32` / `linux`，`x64` / `arm64`）：

   ```json
   {
     "version": "1.14.22",
     "sourceCommit": "87527cb7641a5a42f8f0efb73cb066102e004dee",
     "platform": "win32",
     "arch": "x64",
     "asset": "SnowLuma-v1.14.22-win-x64.zip",
     "sha256": "c8076ba2fbcdc19afeb8e8bf9b2956eaab3605e5fa4618c4db702749ae501681"
   }
   ```

   该文件是面板判断「已安装」的唯一依据；版本号与 `release.ts` 不一致时页面会显示未安装。**不要**为了让别的版本通过检查而改这个版本号——固定版本是校验链的一部分。
5. 刷新面板，状态变为「已安装」后即可点击 **启动 SnowLuma**。

自动安装与手动安装都只写入 `runtime/snowluma/`，不会改动 Agent 的配置、数据库或已存在的账号资料。


## 账号数据库准备失败

若页面提示“账号数据库准备失败，暂不可用并将自动重试”，查看概览及终端中的具体错误。该提示表示账号的数据库准备工作线程尚未就绪，SnowLuma 会按自身流程重试。

2026-10-14 修复了启动包装层的入口兼容问题：SnowLuma 使用 `process.argv[1]` 启动数据库迁移工作线程，旧包装层使该值指向自身，线程因此缺少官方入口参数并报 `ERR_INVALID_ARG_TYPE: The "path" argument must be of type string. Received undefined`。包装层现将入口参数还原为直接启动官方程序时的形式，工作线程能够进入官方数据库准备流程；官方文件和已有账号数据库均不改动。

更新后，在 Agent 的 SnowLuma 页面点击 **停止**，再点击 **启动 SnowLuma**，使新入口生效；Agent 无需重启。保留已有账号数据，不通过删除数据库处理此入口错误。若重启后仍显示准备失败，应根据新的具体错误继续排查。

## 验证

`npm run test:snowluma` 可在**没有安装官方包**的情况下运行：隔离回归使用真实测试子进程、本地 HTTP 服务与合成夹具，覆盖固定版本与校验和、压缩包路径穿越、重复启动、UTF8/标准错误、停止重启、父进程退出、按官方入口创建数据库工作线程并完成准备及迁移、安装取消、摘要不匹配拒绝安装、鉴权、跨站拒绝、Cookie、原生 Token 转发、SSE 和退出清理。该回归已纳入 `npm run test:offline`。

以下两项冒烟需要本地已有官方包，属于开发期验证，仓库本身不附带：

- 对原样官方 Windows 完整包做过实际安装与启动冒烟：WebUI 返回正常页面，代理能加载真实 HTML/脚本，停止后受管进程退出。冒烟显式禁用 QQ 自动注入，没有接受条款、登录账号或发送消息。实际 QQ 接入和收发仍由用户在原界面完成并验证。
- 数据库入口修复另使用官方自带 Node、修复后的 runner 和原样官方迁移工作线程验证：独立合成测试库收到 `ready`，发送 `start` 后到达 `complete` 并正常退出。未打开或迁移用户的真实账号数据库。

