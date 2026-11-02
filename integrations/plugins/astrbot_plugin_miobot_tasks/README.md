# MioBot 私人助手定时任务

三个实际模型工具：`miobot_schedule_reminder`、`miobot_list_reminders`、
`miobot_cancel_reminder`。工具通过经过认证的本机桥访问 MioBot 的现有任务库。
没有独立的轮询器、第二份原生 cron 任务或任意收件人工具。

明确的用户指令（例如“明天早上7点叫我起床”）可以创建 `pending` 一次性任务；
“明天早上”需要先澄清时刻。北京时间在程序层核对，不相信模型自己声明已获授权。
重复提醒暂不支持。查询与取消按服务端确认的用户和助手身份隔离，取消不能撤回已发送消息。

支持本应用 webchat，以及原生 aiocqhttp、qq_official、telegram、discord 的私聊事件。
外部事件必须有真实原生 message_id；群聊或缺失消息编号会拒绝工具调用。
消息原文、编号、发送者及会话身份直接读取 AstrBot event，不属于模型可填的参数。
宿主仍必须先完成私聊身份/渠道绑定及真实送达验证，并核对接收对象；
仅在 metadata 增加平台名称不等于真实平台已经接通或用户已经收到。

请求前钩子可通过同一个本机认证桥将实际外部私聊上报至 `/internal/inbound-trusted`，
用于宿主更新主动关心的上下文。它只上报实际事件，不调用额外模型、发送消息或启动调度。
没有桥配置或上报失败时不阻断普通聊天；宿主负责授权、去重及决定是否保存。

配置使用宿主环境中的 `MIOBOT_TOOL_URL` 与 `MIOBOT_TOOL_TOKEN`。
只接受 loopback 地址，不跟随跳转，不向模型暴露连接令牌。

工具注册/源码属于 MioBot 的集成代码（AGPL-3.0-only），依赖 AstrBot 的开源
事件/模型工具接口、现有 `aiohttp` 运行依赖；不含平台凭据或用户数据。
