"""Actual pinned native tool schemas/events plus isolated loopback bridge tests.

No existing data, real API key, model endpoint, or messaging platform is used.
"""
import atexit
import asyncio
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
isolated = tempfile.TemporaryDirectory(prefix="miobot-research-native-")
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

spec = importlib.util.spec_from_file_location("miobot_research_fixture", ROOT / "integrations/plugins/astrbot_plugin_miobot_research/main.py")
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
plugin = module.MioBotResearch(SimpleNamespace())


def event():
    message = AstrBotMessage()
    message.type = MessageType.FRIEND_MESSAGE
    message.self_id = "fixture-bot"
    message.session_id = "fixture-sender"
    message.message_id = "fixture-message"
    message.sender = MessageMember(user_id="fixture-sender", nickname="fixture")
    message.message = [Plain("明天早上7点叫我起床")]
    message.message_str = "明天早上7点叫我起床"
    message.raw_message = {}
    return AstrMessageEvent(message.message_str, message, PlatformMetadata("webchat", "local fixture", "webchat"), "fixture-session")


class NativeSchemas(unittest.TestCase):
    def test_actual_native_registration_does_not_expose_event_or_recipient_arguments(self):
        expected = {
            "miobot_search_web": {"query", "max_results"},
            "miobot_read_file": {"file_id"},
        }
        for name, fields in expected.items():
            tool = llm_tools.get_func(name)
            self.assertIsNotNone(tool, name)
            self.assertEqual(set(tool.parameters["properties"]), fields)
            self.assertNotIn("event", tool.parameters["properties"])
            self.assertNotIn("ownerId", tool.parameters["properties"])
            self.assertNotIn("channel", tool.parameters["properties"])


class LoopbackBridge(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.calls = []
        self.mode = "normal"

        async def handler(request):
            self.assertEqual(request.path, "/internal/assistant-tools")
            self.assertEqual(request.headers["X-MioBot-Tool-Token"], "t" * 32)
            body = await request.json()
            self.calls.append(body)
            if self.mode == "oversize":
                return web.Response(text="x" * (512 * 1024 + 1))
            if self.mode == "failure":
                return web.json_response({"ok": False, "error": {"code": "NEEDS_CONFIGURATION", "message": "请先配置搜索服务。"}})
            return web.json_response({"ok": True, "task": {"id": "fixture-task", "status": "pending", "dueAt": "2026-11-02T23:00:00Z"}})

        app = web.Application()
        app.router.add_post("/internal/assistant-tools", handler)
        self.runner = web.AppRunner(app)
        await self.runner.setup()
        site = web.TCPSite(self.runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        self.base = f"http://127.0.0.1:{port}"
        os.environ["MIOBOT_TOOL_URL"] = self.base
        os.environ["MIOBOT_TOOL_TOKEN"] = "t" * 32

    async def asyncTearDown(self):
        await self.runner.cleanup()
        os.environ.pop("MIOBOT_TOOL_URL", None)
        os.environ.pop("MIOBOT_TOOL_TOKEN", None)

    async def test_real_event_identity_is_separate_from_model_task_arguments(self):
        item = event()
        result = json.loads(await plugin.miobot_search_web(item, "MioBot fixture", 3))
        self.assertTrue(result["ok"])
        self.assertEqual(self.calls[0]["name"], "search_web")
        self.assertEqual(self.calls[0]["args"], {"query": "MioBot fixture", "maxResults": 3})
        self.assertEqual(self.calls[0]["sessionId"], item.session_id)
        self.assertEqual(self.calls[0]["umo"], item.unified_msg_origin)
        self.assertEqual(self.calls[0]["senderId"], "fixture-sender")
        self.assertEqual(self.calls[0]["platform"], "webchat")
        await plugin.miobot_read_file(item, "11111111-1111-4111-8111-111111111111")
        self.assertEqual([call["name"] for call in self.calls], ["search_web", "read_file"])
        self.assertEqual(self.calls[-1]["args"], {"fileId": "11111111-1111-4111-8111-111111111111"})

    async def test_domain_failure_is_retained_instead_of_claiming_success(self):
        self.mode = "failure"
        result = json.loads(await plugin.miobot_search_web(event(), "fixture"))
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "NEEDS_CONFIGURATION")

    async def test_non_loopback_endpoint_and_oversize_reply_fail_closed(self):
        os.environ["MIOBOT_TOOL_URL"] = "https://example.invalid"
        denied = json.loads(await plugin.miobot_search_web(event(), "fixture"))
        self.assertFalse(denied["ok"])
        self.assertEqual(self.calls, [])
        os.environ["MIOBOT_TOOL_URL"] = self.base
        self.mode = "oversize"
        denied = json.loads(await plugin.miobot_search_web(event(), "fixture"))
        self.assertFalse(denied["ok"])
        self.assertEqual(denied["error"]["code"], "RESEARCH_UNAVAILABLE")


if __name__ == "__main__":
    unittest.main(verbosity=2)
