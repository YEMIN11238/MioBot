# 参与 MioBot

欢迎提交可复现的问题、交互改进和范围明确的 Pull Request。当前版本是早期开发预览版，功能范围和验证情况见 [README](README.md) 与 [功能状态](docs/FEATURES.md)。

## 报告问题

请描述操作系统、运行方式、本地或云端模式、复现步骤、预期结果和实际结果。模型问题请注明服务商协议和模型 ID，无须提供 API Key。

日志、截图、导出文件中请移除个人对话、接收账号、密钥和服务器连接凭据。不要将真实密钥作为测试数据提交。

## 开发与验证

开发环境和可选原生后台测试见 [开发说明](docs/DEVELOPMENT.md)。基础离线检查需要 Node.js 24+、uv 和 Python 3.12，无需完整 AstrBot 或模型账号。先准备独立的文件解析测试环境：

```bash
npm ci
uv venv --python 3.12 .venv-test
uv pip install --python .venv-test/bin/python -r tests/requirements.txt
MIOBOT_TEST_PYTHON="$PWD/.venv-test/bin/python" npm test
node --test deploy/*.test.mjs
npm run build
```

若已按 README 安装完整本机引擎与相关依赖，也可直接执行 `npm test`，默认使用 `.runtime/astrbot-source/.venv/bin/python`。原生后台、插件与工具链路检查仍需完整引擎，不能由独立解析测试环境代替。

这些离线检查不要求真实模型密钥，也不证明模型内容质量、平台真实送达或生产云环境已经验收。新增功能请说明哪些环节使用模拟服务、哪些实际验证过。

修改时请保留助手之间的数据隔离、明确的任务授权、发送防重复处理及失败状态。复杂功能先围绕一个可验证的用户任务提交，便于复核行为变化。

## 来源与许可

请保留引入组件的许可证、原作者署名、版本和修改说明。新增依赖或复用代码时，同时更新 [THIRD_PARTY.md](THIRD_PARTY.md)。MioBot 使用 AGPL-3.0-only；第三方组件适用其各自的许可证。
