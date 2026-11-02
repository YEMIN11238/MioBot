"""Actual native schemas/events and loopback bridge, without paid providers."""
import atexit
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.dont_write_bytecode = True
isolated = tempfile.TemporaryDirectory(prefix="miobot-media-native-")
atexit.register(isolated.cleanup)
os.environ["ASTRBOT_ROOT"] = isolated.name
os.chdir(isolated.name)
sys.path.insert(0, str(ROOT / ".runtime/astrbot-source"))

from aiohttp import web
from astrbot.core.message.components import Plain
from astrbot.core.platform.astr_message_event import AstrMessageEvent
from astrbot.core.platform.astrbot_message import AstrBotMessage, MessageMember
from astrbot.core.platform.message_type import MessageType
from astrbot.core.platform.platform_metadata import PlatformMetadata
from astrbot.core.provider.register import llm_tools

spec = importlib.util.spec_from_file_location("miobot_media_fixture", ROOT / "integrations/plugins/astrbot_plugin_miobot_media/main.py")
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
plugin = module.MioBotMedia(SimpleNamespace())


def event():
    message = AstrBotMessage()
    message.type = MessageType.FRIEND_MESSAGE
    message.self_id = "fixture-bot"
    message.session_id = "fixture-sender"
    message.message_id = "fixture-message"
    message.sender = MessageMember(user_id="fixture-sender", nickname="fixture")
    message.message = [Plain("请发一条语音和一个表情")]
    message.message_str = "请发一条语音和一个表情"
    message.raw_message = {}
    native = AstrMessageEvent(message.message_str, message, PlatformMetadata("webchat", "local fixture", "webchat"), "fixture-session")
    async def never_send(*_args, **_kwargs):
        raise AssertionError("plugin must not directly send any platform message")
    native.send = never_send
    return native


class NativeSchemas(unittest.TestCase):
    def test_only_content_or_owned_sticker_id_is_model_controlled(self):
        for name, fields in {"miobot_voice_reply": {"text"}, "miobot_send_sticker": {"sticker_id"}}.items():
            tool = llm_tools.get_func(name)
            self.assertIsNotNone(tool)
            self.assertEqual(set(tool.parameters["properties"]), fields)
            for private in ["event", "ownerId", "recipient", "path", "url", "apiKey", "apiBase"]:
                self.assertNotIn(private, tool.parameters["properties"])


class LoopbackBridge(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.calls = []
        self.mode = "normal"
        async def handler(request):
            self.assertEqual(request.path, "/internal/assistant-tools")
            self.assertEqual(request.headers["X-MioBot-Tool-Token"], "m" * 32)
            body = await request.json()
            self.calls.append(body)
            if self.mode == "oversized":
                return web.Response(text="x" * 65537)
            if self.mode == "unauthorized":
                return web.Response(status=403)
            if self.mode == "disabled":
                return web.json_response({"ok": False, "error": {"code": "CAPABILITY_DISABLED", "message": "语音尚未启用。"}})
            if body["name"] == "voice_reply":
                return web.json_response({"ok": True, "audio": {"id": "fixture-id", "mime": "audio/wav", "filename": "fixture.wav"}})
            return web.json_response({"ok": False, "error": {"code": "STICKER_SELECTION_REQUIRED", "message": "请选择授权图片。"}, "stickers": [{"id": "fixture-sticker", "name": "开心"}]})
        app = web.Application()
        app.router.add_post("/internal/assistant-tools", handler)
        self.runner = web.AppRunner(app)
        await self.runner.setup()
        site = web.TCPSite(self.runner, "127.0.0.1", 0)
        await site.start()
        self.base = f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}"
        os.environ["MIOBOT_TOOL_URL"] = self.base
        os.environ["MIOBOT_TOOL_TOKEN"] = "m" * 32

    async def asyncTearDown(self):
        await self.runner.cleanup()
        os.environ.pop("MIOBOT_TOOL_URL", None)
        os.environ.pop("MIOBOT_TOOL_TOKEN", None)

    async def test_actual_event_identity_is_forwarded_but_no_direct_platform_send_occurs(self):
        native = event()
        voice = json.loads(await plugin.miobot_voice_reply(native, "这是一条测试语音。"))
        self.assertTrue(voice["ok"])
        self.assertEqual(voice["audio"]["mime"], "audio/wav")
        blank = json.loads(await plugin.miobot_send_sticker(native))
        self.assertFalse(blank["ok"])
        self.assertEqual(blank["error"]["code"], "STICKER_SELECTION_REQUIRED")
        await plugin.miobot_send_sticker(native, "fixture-sticker")
        self.assertEqual([body["name"] for body in self.calls], ["voice_reply", "send_sticker", "send_sticker"])
        self.assertEqual(self.calls[0]["args"], {"text": "这是一条测试语音。"})
        self.assertEqual(self.calls[1]["args"], {})
        self.assertEqual(self.calls[2]["args"], {"stickerId": "fixture-sticker"})
        for body in self.calls:
            self.assertEqual(body["sessionId"], native.session_id)
            self.assertEqual(body["umo"], native.unified_msg_origin)
            self.assertEqual(body["senderId"], native.get_sender_id())
            self.assertEqual(body["platform"], "webchat")

    async def test_failures_and_invalid_bridge_configuration_remain_failures(self):
        for mode in ["disabled", "oversized", "unauthorized"]:
            self.mode = mode
            result = json.loads(await plugin.miobot_voice_reply(event(), "不要伪报成功"))
            self.assertFalse(result["ok"])
            self.assertNotIn("audio", result)
        before = len(self.calls)
        for url in ["https://example.invalid", self.base + "/extra", self.base + "?secret=value"]:
            os.environ["MIOBOT_TOOL_URL"] = url
            result = json.loads(await plugin.miobot_voice_reply(event(), "不应外呼"))
            self.assertEqual(result["error"]["code"], "MEDIA_UNAVAILABLE")
        self.assertEqual(len(self.calls), before)


if __name__ == "__main__":
    unittest.main(verbosity=2)
