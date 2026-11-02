# 将后台放到云端

当前电脑继续本地运行。下载运行包不会迁移账号、资料或聊天。Linux Docker 镜像尚待服务器上的实际构建与验收。

1. 下载运行包，准备可登录、已安装 Docker Engine 和 Compose 的 Linux 服务器。
2. 在下载目录上传文件。请替换示例中的服务器用户和地址。

```sh
scp miobot-cloud-{{version}}.tar.gz 你的服务器用户@服务器地址:~/
```

3. 登录服务器，在文件所在目录解压并启动。

```sh
tar -xzf miobot-cloud-{{version}}.tar.gz
cd miobot-cloud-{{version}}
docker compose -f deploy/compose.yaml up -d --build
docker compose -f deploy/compose.yaml ps
```

4. 在自己的服务器终端取得连接密钥。只复制到客户端的密钥框，不要发到聊天或公开仓库。

```sh
docker compose -f deploy/compose.yaml exec miobot cat /data/cloud-owner-token
```

5. 先通过 SSH 转发验收，保持此窗口开启。

```sh
ssh -N -L 44318:127.0.0.1:4318 你的服务器用户@服务器地址
```

服务地址填写 `http://127.0.0.1:44318`，填入密钥后验证连接。长期使用请按运行包内 README-cloud.md 配置域名与 HTTPS。不要公开未加密的后台端口。

连接后显示云端实例自己的助手和记录。本机待办暂停、主动关心关闭，原数据保留，不自动上传或合并。模型和消息渠道需要在云端配置并测试。应用内提醒进入云端收件箱；电脑关闭时，QQ 等外部提醒需要独立接通并验证。

停止后台并保留资料：

```sh
docker compose -f deploy/compose.yaml stop
```

停止后台不等于停止云服务器计费。备份、恢复和长期连接说明见运行包内 README-cloud.md。
