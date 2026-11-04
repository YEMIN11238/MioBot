# B站基础表情收藏

供 AstrBot 4.29.3 与 `meme_manager v5.2.10-owner-stickers.1` 使用的独立工具插件。只支持已经核验的 B站公开小电视基础包 id 2 中的 11 张固定素材，不搜索 UP 主、不浏览网页、不收付费包，不调用模型。图片名称、分类、资源文件名和 SHA256 固定在 `catalog.json`，来源信息保留在 `pack-manifest.json`。官方标签或图片内容改变时拒绝该素材，不静默扩大来源。

## 使用

先在原版插件配置中显式填写 `owner_qq` 和完整 `owner_umo`。两项默认空，未填或不匹配时不联网、不发图、不改图库。

- `/收B站表情`：实际请求官方固定元数据与 CDN，新增或补缺固定图包 `bilibili-basic-tv`，返回本次新增、已存在和失败数。原包已经安装时可能返回新增 0、重复 11；不能把此前人工导入算成此次新增。
- `/B站表情 doge`：从已安装固定包点发素材，不联网。其他支持名称为白眼、坏笑、生气、疑问、大哭、笑哭、点赞、睡着、偷笑、可爱；省略名称使用 doge。
- `collect_bilibili_basic_stickers`、`send_bilibili_basic_sticker(name)`：对应的 LLM 工具。仍核对主人本次直接明确请求，不能靠模型自行选择、历史、能力问句或嵌套引用授权。

只解析当前顶层唯一文字组件，不递归读取 Reply、Forward、Node 或 JSON 中的内容；主人引用旧消息后另写的新明确指令可用。群聊、其他平台、其他用户和 cron 事件均拒绝。命令先停止默认 LLM 流程；工具返回真实结果，失败不得声称已完成。单个事件最多点发一次，普通聊天仍由原表情包管理器选图。

## 接入与限制

插件通过 `context.get_registered_star("meme_manager")` 找到当前实例，复用其同进程存储及 `_run_guarded_runtime_file_operation`。这是绑定上述版本的内部接口集成，版本或模块不匹配即停止；不读取后台密码、Token 或工作台凭据，不经伪造事件安装图包。没有单独 UI、后台轮询或定时任务。

所有写入只指向固定包；已有图片按同分类 SHA256 去重，补缺沿用原生强图片保存器。只向主人的 session 规则追加该包，保留原主包顺序和 default 规则，不改 QQ 自动收集的 scope、平台表情过滤或视觉审核。PNG 会解码验证；固定点发还需匹配本地目录内已核验的内容 SHA256，因此能兼容原生保存器生成的 UUID 文件名。发图只在原生 `context.send_message` 返回严格的 `True` 后报告成功，这仍需要 QQ 客户端验收实际显示。

请求只允许固定官方 HTTPS 元数据接口及 `i0/i1/i2.hdslb.com/bfs/emote/<40位哈希>.png`，不接受重定向、任意 URL、Cookie、路径或额外 HTTP 凭据。JSON 上限 1 MiB，单图 2 MiB，本轮图片总量 10 MiB，最多 12 张、最多两路并发，图包最多 200 张。收集有 60 秒冷却和单轮 busy 限制；网络阶段共享 75 秒截止，分块读取前后检查，单次 socket 阻塞上限 10 秒，当前 I/O 结束后才可退出。停止插件会取消自有任务并等待下载线程收尾，不把超时 await 当成线程已经停止。

## 离线验证

使用已安装的 Python 3.12 与 Pillow 环境，从 `collector-plugin/` 执行 `python3 -m unittest discover -s tests -v`；macOS 自带的旧 Python 不一定具备这些依赖。测试不联网、不读真实聊天、不使用模型 Key。原生接线测试读取相邻 `dafeiyu-meme-private-20261029/meme_manager` 源码及本任务已下载的公开表情，在临时目录运行真实存储、图片写入和运行时锁方法；外部 HTTP 依赖为禁止联网的替身。测试源不随安装 ZIP 部署。
