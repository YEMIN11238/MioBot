# MioBot 云端运行包

这是把 MioBot 后台放到一台自己管理的 Linux 服务器上的部署入口。Mac 客户端仍用于聊天、配置助手和管理任务；关闭客户端后，云端进程继续运行。它是单用户、单实例方案，尚不提供多人租户管理、自动购买服务器或自动迁移旧机器人。

当前默认保持本地运行。准备云端包、填写绑定界面不会自动迁移现有数据，也不会把当前 QQ 账号、模型密钥或聊天记录上传到服务器。绑定另一实例后，客户端看到的是该实例的数据。

## 当前验证边界

- 本机没有 Docker，因此本版本镜像尚未在本机真实构建或启动。Dockerfile、Compose 和 HTTPS 模板是可供部署验收的配置，不应被描述为已上线。
- 发布包包含 MioBot 源码、前端静态产物、依赖锁文件及许可证；不含本机 `.data`、`.runtime`、macOS Python、账号凭据或运行日志。
- Docker 构建时下载固定的 AstrBot 4.29.3，revision `f61a7f42696da6df25dc7a249ec9b8d54ed9da18`，校验上游 `uv.lock` 后按锁安装 Linux 依赖。LivingMemory 额外依赖固定为 `networkx==3.7`、`pytz==2026.6`，不重新解析或降级核心依赖。
- 模型调用、网页搜索、语音及消息平台仍需用户自己的配置。打包不意味着这些服务已接通；未配置的扩展应显示待配置。

## 1. 制作并上传包

在 MioBot 源码目录执行：

```sh
node scripts/package-cloud.mjs
```

产物在 `release/cloud/miobot-cloud-<版本>.tar.gz`，旁边有 SHA256 校验文件。已有最新 `dist` 时可加 `--skip-build`。打包脚本只复制允许的源码目录，拒绝符号链接，并记录文件清单。

自行准备已能登录的 Ubuntu 服务器，例如 Ubuntu 24.04，安装 Docker Engine 和 Compose 插件。按照 Docker 官方 Linux 安装说明操作，不需要在服务器安装 Mac 软件。首次构建需要访问 GitHub、npm 和 Python 包源；速度、磁盘和内存消耗取决于网络与架构，目前没有实测容量承诺。容器依赖较多，构建时需要额外磁盘和内存；不能用仅完成打包来推断小规格服务器一定够用。

将压缩包和校验文件上传到服务器，例如：

```sh
scp release/cloud/miobot-cloud-<版本>.tar.gz 你的服务器用户@服务器地址:~/
scp release/cloud/miobot-cloud-<版本>.tar.gz.sha256 你的服务器用户@服务器地址:~/
```

在服务器上核验并解压：

```sh
sha256sum -c miobot-cloud-<版本>.tar.gz.sha256
tar -xzf miobot-cloud-<版本>.tar.gz
cd miobot-cloud-<版本>
```

以上尖括号内容需要替换成实际版本或自己的服务器信息。

## 2. 构建并启动

在解压后的源码目录执行：

```sh
docker compose -f deploy/compose.yaml up -d --build
docker compose -f deploy/compose.yaml ps
curl --fail http://127.0.0.1:4318/health
```

服务只把服务器本机的 `127.0.0.1:4318` 映射出来。引擎 `26185` 仅在容器内部访问，不应开公网端口。健康检查只说明 HTTP 服务存活，不表示模型已配置、QQ 已接通或提醒已送达。

一个持久卷 `miobot-data` 保存聊天、助手、任务、通知、上传资料、模型及渠道凭据、引擎数据和运行日志。正常重启或重新构建会保留这个卷。不要使用 `docker compose down -v`，该选项会删除持久数据。

容器以进程方式运行 MioBot 与内置引擎；不是每个助手各租一台云电脑。服务器运行时，已确认的定时任务可由后台执行。应用内通知先进入云端收件箱，关闭客户端时不会弹出本机通知；QQ 等外部投递需要独立接通并验证渠道。停机期间错过的提醒不会被当作准时送达，恢复后需查看任务状态。

## 3. 取得连接密钥

首次启动会在卷内 `/data/cloud-owner-token` 生成随机连接密钥，文件权限为 `0600`。服务日志不会打印密钥。请在自己的服务器终端运行下列命令查看一次，并直接复制到自己的客户端，勿贴入聊天或公开仓库：

```sh
docker compose -f deploy/compose.yaml exec miobot cat /data/cloud-owner-token
```

这是一把可管理该单用户实例全部数据的连接密钥。不要把它放进网址、截图、环境示例或 Git 提交。`MIOBOT_CLOUD_TOKEN_FILE` 可指向自管的绝对路径文件；文件内容必须为至少 32 位的随机字母、数字、下划线或连字符。更换密钥后需重启容器并重新绑定客户端。

## 4. 客户端连接方式

**先在本机安全验收。** 可以通过 SSH 转发连接，无需把 HTTP API 公开到互联网：

```sh
ssh -N -L 44318:127.0.0.1:4318 你的服务器用户@服务器地址
```

保持这个 SSH 窗口打开。在 MioBot 的运行位置设置中选择连接云端，填写 `http://127.0.0.1:44318` 与刚生成的连接密钥，先测试连接，再确认绑定。测试连接只核对实例身份，不能当作模型对话测试。切回本地后使用本地数据，配对不会自动合并双方聊天、记忆或任务。

**需要长期开通时使用 HTTPS。** 准备自己的域名，DNS 指向服务器，允许入站 80、443。将 `deploy/cloud.env.example` 复制为 `deploy/.env`，填写 `MIOBOT_DOMAIN`，然后执行：

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml -f deploy/compose.https.yaml up -d --build
```

客户端填写 `https://你的域名` 与连接密钥。Caddy 负责证书与反向代理，HTTP API 仍有 Bearer 密钥认证。此模板不启用访问日志，避免记录敏感请求；服务器、证书与防火墙由部署者管理。不应把未加密的公网 `http://服务器地址:4318` 当作正式连接方式。

## 5. 部署验收与停止

顺序检查服务健康、无密钥访问被拒绝、正确密钥可读取实例信息，再在客户端配置模型并做真实短对话。创建一个几分钟后的提醒，核对任务状态与收件箱；外部渠道要再核对真实接收端。不要把接口返回成功直接写成用户已经收到。

```sh
curl -i http://127.0.0.1:4318/api/cloud/info
docker compose -f deploy/compose.yaml logs --tail 50 miobot
docker compose -f deploy/compose.yaml stop
```

第一条应返回未授权；不要把真实密钥粘贴进可公开的命令示例。停止后服务与定时任务不再执行，卷会保留。恢复运行用 `docker compose -f deploy/compose.yaml up -d`。停止容器不会停止云厂商计费；若以后不使用，还需在云厂商控制台处理服务器、磁盘、快照和其他计费资源。

备份需包含整个 `/data`，其中含凭据和聊天内容，应加密保管并先做恢复演练。目前没有一键数据迁移或备份恢复界面，不建议运行中手工拼接两份状态文件。

## 环境变量

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `MIOBOT_DATA` | `/data` | 持久数据目录 |
| `MIOBOT_PORT` | `4318` | 云端 API 容器端口 |
| `MIOBOT_SERVER_NAME` | `MioBot 云端` | 客户端显示的实例名称 |
| `MIOBOT_CLOUD_TOKEN_FILE` | `/data/cloud-owner-token` | 随机连接密钥文件 |
| `MIOBOT_ASTRBOT_SOURCE` | 镜像内 `/opt/astrbot` | 固定的原生引擎源码 |
| `MIOBOT_PYTHON` | 镜像内 `/opt/astrbot/.venv/bin/python` | Linux Python 执行路径 |
| `MIOBOT_NO_ENGINE` | 未设置 | 仅隔离测试时设 `1`，跳过引擎启动，不能用于正常聊天部署 |

MioBot 源码遵循仓库 LICENSE。AstrBot、内置插件和游戏资料保留各自许可证与来源，见 `THIRD_PARTY.md`、`public/licenses` 与各集成目录；界面不展示底层产品名称不等于取消这些许可证义务。
