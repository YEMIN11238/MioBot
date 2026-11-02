"""Scoped media requests for MioBot's application-owned voice and sticker service.

The model never supplies a provider endpoint, recipient, user identity or path.
The application validates explicit user intent and returns authenticated assets;
this plugin deliberately does not call event.send or a platform's send API.
"""
import json
import os
from urllib.parse import urlsplit

import aiohttp
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star, register


@register("astrbot_plugin_miobot_media", "MioBot", "可控语音回复与专属表情图库", "0.1.0")
class MioBotMedia(Star):
    def __init__(self, context: Context):
        super().__init__(context)

    async def _call(self, event: AstrMessageEvent, name: str, args: dict) -> str:
        unavailable = {"ok": False, "error": {"code": "MEDIA_UNAVAILABLE", "message": "媒体服务未连接，没有生成语音或发送图片。"}}
        base = os.environ.get("MIOBOT_TOOL_URL", "").rstrip("/")
        token = os.environ.get("MIOBOT_TOOL_TOKEN", "")
        try:
            url = urlsplit(base)
            if url.scheme not in ("http", "https") or url.hostname not in ("127.0.0.1", "localhost", "::1"):
                return json.dumps(unavailable, ensure_ascii=False)
            if url.username or url.password or url.query or url.fragment or url.path or len(token) < 16:
                return json.dumps(unavailable, ensure_ascii=False)
            payload = {"name": name, "args": args, "sessionId": event.session_id,
                       "umo": event.unified_msg_origin, "senderId": event.get_sender_id(),
                       "platform": event.get_platform_name()}
            timeout = aiohttp.ClientTimeout(total=35, connect=3)
            async with aiohttp.ClientSession(timeout=timeout, trust_env=False) as client:
                async with client.post(base + "/internal/assistant-tools", json=payload,
                                       headers={"X-MioBot-Tool-Token": token}, allow_redirects=False) as response:
                    if response.status != 200:
                        return json.dumps(unavailable, ensure_ascii=False)
                    chunks, size = [], 0
                    async for chunk in response.content.iter_chunked(16384):
                        size += len(chunk)
                        if size > 65536:
                            return json.dumps(unavailable, ensure_ascii=False)
                        chunks.append(chunk)
                    result = json.loads(b"".join(chunks))
                    if not isinstance(result, dict) or not isinstance(result.get("ok"), bool):
                        return json.dumps(unavailable, ensure_ascii=False)
                    return json.dumps(result, ensure_ascii=False)
        except Exception:
            return json.dumps(unavailable, ensure_ascii=False)

    @filter.llm_tool(name="miobot_voice_reply")
    async def miobot_voice_reply(self, event: AstrMessageEvent, text: str) -> str:
        """用户明确要求语音，且当前助手已开启语音时，生成一条可播放语音。

        日常文字聊天不要调用，不要凭自己的决定改用语音。服务配置和收件对象由应用确定。
        只有返回ok=true且含audio时，才说语音已生成；失败、关闭、缺配置都不能声称已发送。
        返回的附件由当前聊天界面展示，不表示QQ或其它外部平台已收到。

        Args:
            text(string): 要朗读的正式回复，1到500字，不包含内部分析或工具信息。
        """
        return await self._call(event, "voice_reply", {"text": text})

    @filter.llm_tool(name="miobot_send_sticker")
    async def miobot_send_sticker(self, event: AstrMessageEvent, sticker_id: str = "") -> str:
        """用户明确要求表情且已启用时，从当前助手的授权图库选择图片。

        不指定编号会返回可选表情列表，不会自动随机发送。先拿到真实编号，再选择合适的一张调用。
        不能读取任意路径、抓取网络图片、跨助手取图或替用户发送给其它人。
        只有ok=true且含sticker时才确认图片可展示；失败时不要口头说已发图。

        Args:
            sticker_id(string): 授权图库返回的真实表情编号；留空先查询可选表情。
        """
        return await self._call(event, "send_sticker", {"stickerId": sticker_id} if sticker_id else {})
