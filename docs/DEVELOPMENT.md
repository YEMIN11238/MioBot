# 开发、验证与构建

本页面向运行源码和参与开发的使用者。MioBot 当前为 0.6.1 预览版；测试通过的范围、实际平台账号验收与正式发行应分别判断。

## 技术与目录

| 目录 | 职责 |
| --- | --- |
| `src/` | 桌面与手机 React 页面、共享 API 与连接恢复、聊天、任务、记忆及设备配对入口 |
| `desktop/` | Electron 窗口、单实例、本地服务生命周期、系统通知 |
| `server/` | Node.js API、设备会话与局域网监听、状态与凭据存储、工具权限、提醒和主动关心调度、云端代理 |
| `shared/` | 前后端共享的产品文本和回复展示规则 |
| `integrations/` | 已署名的插件源码、适配插件、Skills、游戏数据与来源记录 |
| `runtime/` | 固定版引擎依赖锁，不包含个人运行数据 |
| `deploy/` | Linux Docker、Compose、HTTPS 和云端启动配置 |
| `scripts/` | 运行时补丁、打包与离线验证入口 |
| `tests/` | Node.js 自动化检查与隔离的原生引擎测试辅助脚本 |
| `public/licenses/`、`licenses/` | 随界面与分发保留的第三方许可 |

界面通过 MioBot Node.js 服务访问托管 AstrBot 4.29.3；模型、原生会话和工具循环由 AstrBot 运行。MioBot 把当前助手允许的工具、人设和模型配置同步到对应原生配置，并管理应用状态、提醒确认、投递和云端连接。

已保存的模型凭据不会通过普通状态接口返回；文件与媒体通过编号和范围检查读取，不向模型提供任意服务器路径。任务写入与外部投递分别记录结果，同一条请求有重复创建保护。

## 开发环境

当前源码与桌面打包按 macOS Apple Silicon 验证。需要 Git、Node.js 24+、uv 和可下载 Python 3.12 的网络。先执行根目录 README 的安装步骤。`安装引擎.command` 会获取固定 AstrBot 版本、复制依赖锁、应用托管补丁，并补齐增强记忆当前固定的 `networkx` 和 `pytz` 依赖。仍需完成独立新电脑上的全流程验收。

首次本机启动使用独立后台，可能下载固定版本界面资源。若端口上已有其他后台，应用会拒绝接管；请调整运行方式或明确连接自己的已有实例。默认应用端口为 `4318`，托管引擎为 `26185`，均按本机使用配置。

```sh
npm run dev
```

开发服务使用 Vite 中间件提供界面。需要真实聊天时，仍需完成本机引擎和模型连接配置。不要把开发服务直接暴露到公网。

## 数据目录

- 源码运行默认使用 `.data/`，桌面沿用系统应用数据目录中的 `Personal Agent/`。
- `state.json` 保存应用状态、聊天、手动记忆、任务与通知；`credentials.json` 保存私有连接凭据。
- 引擎和插件数据库、增强记忆及其备份位于同一实例数据根目录下的独立引擎目录。
- 日志保存在实例的数据目录中。日志、截图和测试产物可能含用户信息，不应直接上传。
- 本地和云端实例默认使用各自资料，连接或切换不会自动合并数据。

私有目录和文件权限不等于磁盘加密。使用外部模型时，相关文本仍会发送到配置的模型服务。修改存储逻辑时应同时考虑聊天原文、当前记忆库、附件和备份，不能只删除单份索引后宣称全部清除。

## 基础检查

基础离线测试无需安装完整 AstrBot 或配置模型账号，但 PDF / DOCX 解析测试需要 Python 3.12 和测试依赖。若只准备验证源码，可使用独立测试环境：

```sh
npm ci
uv venv --python 3.12 .venv-test
uv pip install --python .venv-test/bin/python -r tests/requirements.txt
MIOBOT_TEST_PYTHON="$PWD/.venv-test/bin/python" npm test
node --test deploy/*.test.mjs
npm run build
```

`MIOBOT_TEST_PYTHON` 只为解析与文件测试选择 Python，不会启动真实助手后台。若已按 README 准备完整的本机引擎与相应依赖，也可直接运行 `npm test`，默认使用 `.runtime/astrbot-source/.venv/bin/python`。后面的原生链路检查仍需要完整引擎，独立测试环境不能替代。

2026-11-03 发布准备时重新运行：主测试 179 项、部署测试 6 项，共 185 项通过；前端构建通过。该口径为离线自动化检查数，不是 185 个真实用户任务、模型质量评审或平台送达样本。

同日还从 Git 暂存索引导出全部待公开文件到临时目录，未复制 `.data/`、`.runtime/` 或 `node_modules/`。在设置 `ELECTRON_SKIP_BINARY_DOWNLOAD=1` 后重新执行 `npm ci`，独立 Python 3.12 环境仅安装 `tests/requirements.txt` 的四项依赖，再通过 `MIOBOT_TEST_PYTHON` 指定该环境，179 项主测试、6 项部署测试与前端构建均通过。这证明公开源码的基础离线检查可脱离现用数据与已安装引擎运行；未安装或启动 AstrBot，也不代表原生后台、Electron 安装或 Linux 云部署已完成验收。

`npm test` 执行 `tests/*.test.mjs`，部署脚本测试单独执行。主要覆盖：

- 状态持久化、私有凭据不回传和参数校验。
- 模型连接字段分离、模型 ID、错误脱敏与回复显示。
- 一次性提醒确认、时间核对、取消、重启和重复请求处理。
- 基础记忆范围、显式共享、保存失败与上下文预算。
- 工具白名单、上传文件与私有媒体范围、来源地址检查。
- 云端配对、认证、断线恢复、本地任务暂停及双服务独立调度。
- 页面交互状态和预设能力的配置一致性。

这些是自动化检查，不是同等数量的真实用户任务。测试中的模拟模型、向量服务和外部渠道不能用来推算真实模型质量、送达率、平均费用或效率提升。

### 0.6.0 手机 Web 检查（2026-11-04）

本次实现后重新运行 `npm test` 223 项、`node --test deploy/*.test.mjs` 6 项，共 229 项通过。检查使用隔离数据、真实本机 HTTP 边界与替身模型，不调用付费模型；这个数字是自动化用例数，不是实际手机、真实用户任务或通知送达的样本数。0.5.0 的 185 项记录保留为历史验证，不与当前数量累加。

新增覆盖一次性配对、设备会话哈希与撤销、个人设备的路由权限、局域网开关、HTTP 来源校验、后台回复在观看页面断开后继续、同请求重复提交与显式停止、T3 重试函数适配、连接恢复不重放写操作、北京时间任务编辑及迟到确认保护。浏览器 390px / 320px 交互核查与真实 iPhone 扫码是不同层次的验证；当前不据此声称真实 iOS / Android、APNs/FCM 推送或 Linux 公网部署已验收。

### 0.6.1 手机键盘修复（2026-11-04）

根据用户在 iPhone 上聚焦聊天输入框后页面上移、留下大块空白的截图，移动端改为固定外壳，并同时跟踪可视视口高度和顶部偏移。键盘展开时收起底部导航；关闭后恢复。原本在聊天底部时保持最新消息可见，正在阅读历史时保留位置；不禁止双指缩放。

新增 8 项视口事件与滚动回归测试，覆盖展开／收起、仅偏移变化、缩放、横屏、外接键盘、延迟事件及卸载清理。浏览器使用可控 VisualViewport 指标检查布局和草稿保留，不能代替用户在真实 iPhone 键盘上的复验。

## 隔离原生链路检查

以下辅助脚本需要先准备固定版本引擎。它们使用真实引擎和插件，主要配合本机模拟模型、临时数据和受控时钟，避免读取现用资料：

```sh
node scripts/astrbot-smoke.mjs
node tests/helpers/capabilities-smoke.mjs
node tests/helpers/game-agent-smoke.mjs
node tests/helpers/personality-agent-smoke.mjs
node tests/helpers/proactive-native-smoke.mjs
```

用途分别为原生会话与人格、增强记忆与隔离、固定游戏资料工具、短回复清理链，以及主动关心策略接口。脚本可能生成本地 `artifacts/` 报告；该目录不作为公开源码内容。

直接检查插件类和钩子的入口：

```sh
.runtime/astrbot-source/.venv/bin/python tests/helpers/clean-plugin-smoke.py
.runtime/astrbot-source/.venv/bin/python tests/helpers/humanizer-plugin-smoke.py
.runtime/astrbot-source/.venv/bin/python tests/helpers/proactive-plugin-smoke.py
node --test tests/helpers/proactive-policy.test.mjs
```

单次真实请求、原生工具回传、文件生成和用户实际采用是不同的证据。历史本机测试包含少量真实聊天、搜索、配方与记忆调用样例，不构成长期效果或覆盖全部服务商的承诺。真实模型与消息平台测试应使用自己明确选择的账号，单独记录调用与发送范围。

## macOS 桌面构建

```sh
npm run build
node scripts/package-mac.mjs --out release/mobile-preview-0.6.0
```

当前脚本只接受 `darwin/arm64`。上面的 `--out` 将手机预览版输出到 `release/mobile-preview-0.6.0/MioBot-darwin-arm64/MioBot.app`，保留原有桌面包；不传 `--out` 时仍使用 `release/MioBot-darwin-arm64/MioBot.app`。它需要已准备好的固定版 Python、引擎依赖和启动后获得的界面静态资源；不保证在任意新电脑上直接运行打包命令即可成功。

打包时提供 Python、引擎代码、插件和所需资源，不复制 `.data/`、运行日志或聊天凭据。关闭窗口会隐藏桌面并保留后台，真正退出应用会停止本实例持有的服务。

当前尚未完成正式签名、公证与独立干净机器安装验收。不要把一个本机构建成功的 `.app` 直接视为跨平台正式发行版。

## 云端构建与验收

```sh
node scripts/package-cloud.mjs
```

输出源码运行包、清单与 SHA256 校验文件，不包含本机 macOS 运行环境或用户数据。Docker 构建从固定上游版本获取 Linux 运行依赖。部署步骤及 HTTPS、持久卷、连接密钥和停止方式见 [README-cloud.md](../README-cloud.md)。

云端服务的本机双服务测试已覆盖配对、令牌认证、代理、掉线和独立调度。当前仓库没有真实 Linux Docker 构建上线的验收结论，也没有实测服务器规格、并发承载或月均费用承诺。

发布前至少需要在隔离实例核对：启动与健康检查、未授权请求被拒绝、模型真实短对话、一次性提醒、客户端关闭后后台继续工作、重启后状态、外部接收端实际送达，以及持久数据备份恢复。

## 托管运行时的修改边界

AstrBot 不是完全未修改的依赖。`server/assistant-runtime.mjs` 与 `scripts/patch-managed-runtime.mjs` 保留补丁实现：当 MioBot 设置托管标记时，禁用模型自动获得的原生直接发送工具；同步配置也关闭原生 cron 工具，让提醒授权和投递归 MioBot 服务管理。未设置标记的上游独立运行方式保持原行为。

LivingMemory 有严格 persona 范围检查；人格、主动关心和回复清理插件也有托管适配。原始代码、固定版本、具体修改和许可证见 [THIRD_PARTY.md](../THIRD_PARTY.md) 及各集成目录中的 `NOTICE.md`、来源 JSON。

修改这些边界时，需要验证应用内聊天与外部渠道、主动生成、停止重试等所有入口，防止出现两套调度、重复投递或绕过用户选择。

## 手机连接的实现边界

- `src/MobileApp.jsx`、`src/mobile.css` 提供四页移动界面；`src/client-api.mjs` 统一同源请求，设备会话由 HttpOnly Cookie 携带。
- `src/connection-recovery.mjs` 管理唯一的刷新与恢复循环。重连只读取权威状态，提交使用自己的稳定请求编号；恢复不会自动重放 POST。
- `server/device-sessions.mjs` 保存配对码和设备会话的哈希、有效期与撤销状态；`server/device-access.mjs` 将本机所有者、云端所有者及个人设备授权分开。
- `server/device-network.mjs` 管理默认关闭的局域网监听，与桌面本机端口分开。手机通过同一实例访问资料，不新建第二套记忆或提醒调度器。
- 聊天运行由后台持有。SSE 连接断开只结束观看，显式取消才中止任务；后续客户端通过状态读取已有结果。服务进程本身退出仍会中断生成。

T3 Code 的具体复用范围是小型重试函数及常量，源码、固定提交和 MIT 许可记录在 [integrations/t3code](../integrations/t3code/NOTICE.md)。完整 Effect 连接运行时、T3 Connect、编程 provider、官方移动 App 和推送基础设施均未接入。手机号、QQ 号或其他外部用户不会因设备配对自动归并。

手机操作与局域网/云端使用步骤见 [MOBILE.md](MOBILE.md)。客户端的手机系统通知状态应持续显示尚未接通，直到真实推送链路单独验收通过。

## 提交反馈

请提供系统版本与芯片架构、MioBot 版本、复现步骤、预期和实际行为。模型问题同时提供服务商协议、准确模型 ID 与经过脱敏的错误码，不要提交真实密钥、私人渠道凭据、用户聊天数据库或未经检查的截图。

当前没有将本地聊天反馈自动上传为训练数据的流程，也没有模型训练、多 Agent 编排或 Hermes 执行后端集成。
