"""Owner-requested collection and delivery of eleven fixed public TV stickers."""

import asyncio
import base64
import json
import time

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.message_components import Image
from astrbot.api.star import Context, Star
from astrbot.core.message.message_event_result import MessageChain

from . import core
from .adapter import MemeAdapter


class BilibiliBasicStickers(Star):
    def __init__(self, context: Context, config=None):
        super().__init__(context)
        self.config = config if config is not None else {}
        self._active = True
        self._lock = asyncio.Lock()
        self._send_lock = asyncio.Lock()
        self._tasks = set()
        self._last_started = -float("inf")

    async def terminate(self):
        self._active = False
        pending = tuple(self._tasks)
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)

    async def _download(self):
        worker = asyncio.create_task(asyncio.to_thread(core.download_selected))
        try:
            return await asyncio.shield(worker)
        except asyncio.CancelledError:
            # Cancelled awaiters must not leave a second collector thread alive.
            try:
                await asyncio.shield(worker)
            except Exception:
                pass
            raise

    async def _perform_collect(self, adapter, event):
        downloaded = await self._download()
        if not self._active:
            raise asyncio.CancelledError()
        return await adapter.collect(downloaded, event, self.config["owner_umo"])

    async def _collect(self, event):
        if not self._active or not core.is_owner_event(event, self.config) or not core.is_collect_request(event):
            return {"ok": False, "reason": "未执行：只接受主人当前私聊的明确收集请求，可发 /收B站表情。"}
        previous = event.get_extra("bilibili_basic_collect_result")
        if previous is not None:
            return previous
        if self._lock.locked():
            return {"ok": False, "reason": "已有一轮收集在进行，请等它完成。"}
        async with self._lock:
            wait = 60 - (time.monotonic() - self._last_started)
            if wait > 0:
                return {"ok": False, "reason": f"收集冷却中，请约{int(wait) + 1}秒后重试。"}
            try:
                adapter = MemeAdapter.from_context(self.context)
                self._last_started = time.monotonic()
                task = asyncio.create_task(self._perform_collect(adapter, event))
                self._tasks.add(task)
                try:
                    result = await task
                finally:
                    self._tasks.discard(task)
            except core.CollectorError as exc:
                result = {"ok": False, "reason": str(exc)}
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning("[BilibiliBasicStickers] collect failed: %s", type(exc).__name__)
                result = {"ok": False, "reason": "收集未完成，未确认成功；请查看后台错误类型。"}
            event.set_extra("bilibili_basic_collect_result", result)
            return result

    async def _send(self, event, name):
        async with self._send_lock:
            return await self._send_locked(event, name)

    async def _send_locked(self, event, name):
        if not self._active or not core.is_owner_event(event, self.config):
            return {"ok": False, "reason": "未执行：仅主人当前 QQ 私聊可点发基础表情。"}
        try:
            expected = core.canonical_name(name)
            requested = core.requested_send(event)
            if requested is None or requested["id"] != expected["id"]:
                return {"ok": False, "reason": "未执行：当前直接消息没有要求这张基础表情。"}
            if event.get_extra("bilibili_basic_sent") is not None:
                return {"ok": True, "already_sent": True, "reason": "本轮已实际发送一张，不重复发送。"}
            adapter = MemeAdapter.from_context(self.context)
            path = adapter.image_path(name)
            with path.open("rb") as file:
                content = file.read(core.MAX_IMAGE + 1)
            detail = core.verify_png(content)
            if detail["sha256"] != expected["sha256"]:
                raise core.CollectorError("安装素材已变化，未发送")
            image = Image.fromBase64(base64.b64encode(content).decode("ascii"))
            image = await adapter.mm._ensure_image_send_format(image)
            accepted = await self.context.send_message(event.unified_msg_origin, MessageChain([image]))
            if accepted is not True:
                return {"ok": False, "reason": "QQ发送路由未接受这次发图，未确认成功。"}
            event.set_extra("bilibili_basic_sent", expected["id"])
            return {"ok": True, "sent": True, "name": expected["name"], "pack_id": core.PACK_ID}
        except core.CollectorError as exc:
            return {"ok": False, "reason": str(exc)}
        except Exception as exc:
            logger.warning("[BilibiliBasicStickers] send failed: %s", type(exc).__name__)
            return {"ok": False, "reason": "这次未确认发图成功，请勿声称已经发送。"}

    @filter.command("收B站表情")
    async def collect_command(self, event: AstrMessageEvent):
        event.stop_event()
        if not core.is_owner_event(event, self.config):
            return
        result = await self._collect(event)
        if result.get("ok"):
            text = f"B站小电视基础表情：本次新增{result['added']}张，已存在{result['duplicates']}张，失败{result['failed']}张。"
        else:
            text = result["reason"]
        yield event.plain_result(text)

    @filter.command("B站表情")
    async def send_command(self, event: AstrMessageEvent, name: str = "doge"):
        event.stop_event()
        if not core.is_owner_event(event, self.config):
            return
        result = await self._send(event, name)
        if not result.get("ok"):
            yield event.plain_result(result["reason"])

    @filter.llm_tool(name="collect_bilibili_basic_stickers")
    async def collect_tool(self, event: AstrMessageEvent):
        """主人当前明确要求收B站基础表情时，实际收集已支持的小电视基础素材。

        仅11张固定公开表情，不搜索UP主、不浏览B站、不支持付费包。能力询问、
        历史和引用本身不能授权；不接收URL或Cookie。只按真实新增、重复和失败数确认。
        """
        return json.dumps(await self._collect(event), ensure_ascii=False)

    @filter.llm_tool(name="send_bilibili_basic_sticker")
    async def send_tool(self, event: AstrMessageEvent, name: str = "doge"):
        """主人当前明确点名B站基础表情时，发送固定已安装素材，不从网络找图。

        已发送才可确认，不重复发图，不接受任意文件或URL。

        Args:
            name(string): 仅doge、白眼、坏笑、生气、疑问、大哭、笑哭、点赞、睡着、偷笑、可爱。
        """
        return json.dumps(await self._send(event, name), ensure_ascii=False)
