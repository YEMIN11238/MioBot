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
isolated = tempfile.TemporaryDirectory(prefix="miobot-tasks-native-")
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

spec = importlib.util.spec_from_file_location("miobot_tasks_fixture", ROOT / "integrations/plugins/astrbot_plugin_miobot_tasks/main.py")
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
plugin = module.MioBotTasks(SimpleNamespace())


def event(platform="webchat", *, message_id="fixture-message", private=True):
    message = AstrBotMessage()
    message.type = MessageType.FRIEND_MESSAGE if private else MessageType.GROUP_MESSAGE
    message.self_id = "fixture-bot"
    message.session_id = "fixture-sender"
    message.message_id = message_id
    message.sender = MessageMember(user_id="fixture-sender", nickname="fixture")
    message.message = [Plain("明天早上7点叫我起床")]
    message.message_str = "明天早上7点叫我起床"
    message.raw_message = {}
    return AstrMessageEvent(message.message_str, message, PlatformMetadata(platform, "local fixture", platform), "fixture-session")


class NativeSchemas(unittest.TestCase):
    def test_actual_native_registration_does_not_expose_event_or_recipient_arguments(self):
        expected = {
            "miobot_schedule_reminder": {"title", "due_at"},
            "miobot_list_reminders": {"include_completed"},
            "miobot_cancel_reminder": {"task_id"},
        }
        for name, fields in expected.items():
            tool = llm_tools.get_func(name)
            self.assertIsNotNone(tool, name)
            self.assertEqual(set(tool.parameters["properties"]), fields)
            self.assertNotIn("event", tool.parameters["properties"])
            self.assertNotIn("ownerId", tool.parameters["properties"])
            self.assertNotIn("channel", tool.parameters["properties"])
            self.assertNotIn("userText", tool.parameters["properties"])
            self.assertNotIn("messageId", tool.parameters["properties"])
            self.assertNotIn("umo", tool.parameters["properties"])
            self.assertNotIn("platform", tool.parameters["properties"])


class LoopbackBridge(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.calls = []
        self.receipts = []
        self.mode = "normal"

        async def handler(request):
            self.assertEqual(request.headers["X-MioBot-Tool-Token"], "t" * 32)
            body = await request.json()
            if request.path == "/internal/inbound-trusted":
                self.receipts.append(body)
                if self.mode == "failure":
                    return web.Response(status=503)
                return web.json_response({"ok": True})
            self.assertEqual(request.path, "/internal/assistant-tools")
            self.calls.append(body)
            if self.mode == "oversize":
                return web.Response(text="x" * 262145)
            if self.mode == "failure":
                return web.json_response({"ok": False, "error": {"code": "NEEDS_TIME", "message": "请确认具体几点。"}})
            return web.json_response({"ok": True, "task": {"id": "fixture-task", "status": "pending", "dueAt": "2026-11-02T23:00:00Z"}})

        app = web.Application()
        app.router.add_post("/internal/assistant-tools", handler)
        app.router.add_post("/internal/inbound-trusted", handler)
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
        result = json.loads(await plugin.miobot_schedule_reminder(item, "起床", "2026-11-03T07:00:00+08:00"))
        self.assertTrue(result["ok"])
        self.assertEqual(self.calls[0]["name"], "schedule_reminder")
        self.assertEqual(self.calls[0]["args"], {"title": "起床", "dueAt": "2026-11-03T07:00:00+08:00"})
        self.assertEqual(self.calls[0]["sessionId"], item.session_id)
        self.assertEqual(self.calls[0]["umo"], item.unified_msg_origin)
        self.assertEqual(self.calls[0]["senderId"], "fixture-sender")
        self.assertEqual(self.calls[0]["platform"], "webchat")
        self.assertEqual(self.calls[0]["userText"], item.message_str)
        self.assertEqual(self.calls[0]["messageId"], item.message_obj.message_id)
        await plugin.miobot_list_reminders(item, True)
        await plugin.miobot_cancel_reminder(item, "fixture-task")
        self.assertEqual([call["name"] for call in self.calls], ["schedule_reminder", "list_reminders", "cancel_reminder"])

    async def test_supported_native_private_platforms_forward_actual_event_only(self):
        for platform in ("aiocqhttp", "qq_official", "telegram", "discord"):
            item = event(platform, message_id=12345)
            result = json.loads(await plugin.miobot_list_reminders(item))
            self.assertTrue(result["ok"])
            body = self.calls[-1]
            self.assertEqual(body["platform"], platform)
            self.assertEqual(body["messageId"], "12345")
            self.assertEqual(body["userText"], item.message_str)
            self.assertEqual(body["umo"], item.unified_msg_origin)
            self.assertEqual(body["args"], {"includeCompleted": False})

    async def test_external_groups_missing_native_message_ids_and_unknown_platforms_are_refused(self):
        for item in (event("aiocqhttp", private=False), event("telegram", message_id=""),
                     event("discord", message_id=None), event("unverified-fixture")):
            result = json.loads(await plugin.miobot_list_reminders(item))
            self.assertFalse(result["ok"])
        self.assertEqual(self.calls, [])

    async def test_inbound_hook_records_real_private_event_without_modifying_model_request(self):
        req = SimpleNamespace(prompt="fixture prompt", tools=["fixture unchanged"])
        item = event("aiocqhttp")
        await plugin.record_trusted_inbound(item, req)
        self.assertEqual(len(self.receipts), 1)
        body = self.receipts[0]
        self.assertEqual(body, {"sessionId": item.session_id, "umo": item.unified_msg_origin,
                               "senderId": item.get_sender_id(), "platform": "aiocqhttp",
                               "userText": item.message_str, "messageId": item.message_obj.message_id})
        self.assertEqual(req.prompt, "fixture prompt")
        self.assertEqual(req.tools, ["fixture unchanged"])
        self.assertEqual(self.calls, [])
        await plugin.record_trusted_inbound(event("aiocqhttp", private=False), req)
        await plugin.record_trusted_inbound(event("discord", message_id=""), req)
        await plugin.record_trusted_inbound(event(), req)
        self.assertEqual(len(self.receipts), 1)

    async def test_inbound_failure_does_not_interrupt_chat_or_add_tools(self):
        self.mode = "failure"
        req = SimpleNamespace(prompt="still unchanged")
        self.assertIsNone(await plugin.record_trusted_inbound(event("qq_official"), req))
        os.environ["MIOBOT_TOOL_URL"] = "https://example.invalid"
        self.assertIsNone(await plugin.record_trusted_inbound(event("discord"), req))
        self.assertEqual(req.prompt, "still unchanged")
        self.assertEqual(len(self.receipts), 1)
        self.assertEqual(self.calls, [])

    async def test_domain_failure_is_retained_instead_of_claiming_success(self):
        self.mode = "failure"
        result = json.loads(await plugin.miobot_schedule_reminder(event(), "起床", "2026-11-03T07:00:00+08:00"))
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "NEEDS_TIME")

    async def test_non_loopback_endpoint_and_oversize_reply_fail_closed(self):
        os.environ["MIOBOT_TOOL_URL"] = "https://example.invalid"
        denied = json.loads(await plugin.miobot_list_reminders(event()))
        self.assertFalse(denied["ok"])
        self.assertEqual(self.calls, [])
        os.environ["MIOBOT_TOOL_URL"] = self.base
        self.mode = "oversize"
        denied = json.loads(await plugin.miobot_list_reminders(event()))
        self.assertFalse(denied["ok"])
        self.assertEqual(denied["error"]["code"], "TASK_UNAVAILABLE")


if __name__ == "__main__":
    unittest.main(verbosity=2)
