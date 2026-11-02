"""MioBot one-time reminders via the authenticated application task scheduler.

AstrBot supplies model tool invocation and current event identity. It does not
start a second timer or accept a model-supplied recipient/assistant identity.
"""
import json
import os
from urllib.parse import urlsplit

import aiohttp
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star, register


PRIVATE_PLATFORMS = {"aiocqhttp", "qq_official", "telegram", "discord"}


@register("astrbot_plugin_miobot_tasks", "MioBot", "私人助手一次性定时提醒、查询和取消", "0.1.1")
class MioBotTasks(Star):
    def __init__(self, context: Context):
        super().__init__(context)

    def _event_identity(self, event: AstrMessageEvent):
        """Host identity is read from the event, never from model arguments."""
        platform = event.get_platform_name()
        message_id = getattr(event.message_obj, "message_id", None)
        user_text = event.message_str
        if not isinstance(user_text, str) or len(user_text) > 16000:
            return None
        if platform != "webchat":
            if platform not in PRIVATE_PLATFORMS or not event.is_private_chat():
                return None
            if message_id is None or str(message_id).strip() == "":
                return None
        return {"sessionId": event.session_id, "umo": event.unified_msg_origin,
                "senderId": event.get_sender_id(), "platform": platform,
                "userText": user_text,
                "messageId": str(message_id) if message_id is not None else ""}

    async def _post(self, path: str, payload: dict, *, total: int = 10):
        base = os.environ.get("MIOBOT_TOOL_URL", "").rstrip("/")
        token = os.environ.get("MIOBOT_TOOL_TOKEN", "")
        try:
            url = urlsplit(base)
            if url.scheme not in ("http", "https") or url.hostname not in ("127.0.0.1", "localhost", "::1"):
                return None
            if url.username or url.password or url.query or url.fragment or url.path or len(token) < 16:
                return None
            timeout = aiohttp.ClientTimeout(total=total, connect=min(3, total))
            async with aiohttp.ClientSession(timeout=timeout, trust_env=False) as client:
                async with client.post(base + path, json=payload,
                                       headers={"X-MioBot-Tool-Token": token}, allow_redirects=False) as response:
                    if response.status != 200:
                        return None
                    chunks, size = [], 0
                    async for chunk in response.content.iter_chunked(16384):
                        size += len(chunk)
                        if size > 262144:
                            return None
                        chunks.append(chunk)
                    result = json.loads(b"".join(chunks))
                    if not isinstance(result, dict) or not isinstance(result.get("ok"), bool):
                        return None
                    return result
        except Exception:
            return None

    async def _call(self, event: AstrMessageEvent, name: str, args: dict) -> str:
        unavailable = {"ok": False, "error": {"code": "TASK_UNAVAILABLE", "message": "定时服务当前未连接，没有创建、取消或发送任何提醒。"}}
        try:
            identity = self._event_identity(event)
            if identity is None:
                return json.dumps(unavailable, ensure_ascii=False)
            result = await self._post("/internal/assistant-tools", {**identity, "name": name, "args": args})
            return json.dumps(result or unavailable, ensure_ascii=False)
        except Exception:
            return json.dumps(unavailable, ensure_ascii=False)

    @filter.on_llm_request()
    async def record_trusted_inbound(self, event: AstrMessageEvent, req) -> None:
        """Best-effort receipt tracking; the host still authorizes each identity."""
        try:
            identity = self._event_identity(event)
            if identity is None or identity["platform"] == "webchat":
                return
            # No tools, model request, outbound message or second scheduler here.
            await self._post("/internal/inbound-trusted", identity, total=2)
        except Exception:
            return

    @filter.llm_tool(name="miobot_schedule_reminder")
    async def miobot_schedule_reminder(self, event: AstrMessageEvent, title: str, due_at: str) -> str:
        """按用户明确的时间和内容，创建一次性提醒；当前会话决定接收对象。

        “明天早上叫我”没有具体几点，必须先问清楚，不能猜时间。明确如“明天早上7点叫我起床”即授权创建，不要仅口头答应。
        先核对当前北京时间，把执行时间转为带Z或+08:00的ISO格式。仅当工具ok=true且task.status=pending时确认已安排，并说明返回的实际时间和接收位置。
        工具失败或渠道未接通时不得声称已设置。当前不支持重复提醒；不得将“每天”悄悄改为只提醒一次。

        Args:
            title(string): 用户要求提醒的内容，1到100字。
            due_at(string): 明确时区的未来一次性时间，例如2026-11-03T07:00:00+08:00；默认按北京时间理解。
        """
        return await self._call(event, "schedule_reminder", {"title": title, "dueAt": due_at})

    @filter.llm_tool(name="miobot_list_reminders")
    async def miobot_list_reminders(self, event: AstrMessageEvent, include_completed: bool = False) -> str:
        """列出当前用户与当前助手的提醒，不能查询别人的提醒。根据返回的实际状态回答，不编造任务。

        Args:
            include_completed(boolean): 是否也列出已完成或已取消的提醒，默认false。
        """
        return await self._call(event, "list_reminders", {"includeCompleted": include_completed})

    @filter.llm_tool(name="miobot_cancel_reminder")
    async def miobot_cancel_reminder(self, event: AstrMessageEvent, task_id: str) -> str:
        """用户明确要求取消时，取消当前用户与助手的一条提醒。

        必须先通过列表得到真实任务编号，不能猜。只有ok=true且task.status=cancelled才说已取消；已发送的消息不能撤回。

        Args:
            task_id(string): 提醒列表返回的真实任务id。
        """
        return await self._call(event, "cancel_reminder", {"taskId": task_id})
