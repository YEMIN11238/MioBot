"""Real pinned AstrBot imports; managed QQ guards with no network or paid calls."""
from __future__ import annotations
import asyncio
import importlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import types
import unittest
from unittest.mock import AsyncMock, Mock, patch

ROOT = Path(__file__).resolve().parents[2]
TEMP = tempfile.mkdtemp(prefix="miobot-cloud-qq-")
os.environ["MIOBOT_MANAGED_CLOUD_PLUGINS"] = "1"
os.environ["ASTRBOT_ROOT"] = TEMP
sys.path.insert(0, str(ROOT / ".runtime/astrbot-source"))
package = types.ModuleType("miobot_cloud_qq_test")
package.__path__ = [str(ROOT / "integrations/cloud-plugins")]
sys.modules[package.__name__] = package
profile = importlib.import_module(package.__name__ + ".astrbot_plugin_qqprofile.main")
signature = importlib.import_module(package.__name__ + ".astrbot_plugin_dafeiyu_signature.main")
qzone = importlib.import_module(package.__name__ + ".astrbot_plugin_qzone.main")
parser = importlib.import_module(package.__name__ + ".astrbot_plugin_qzone.core.qzone.parser")
renderer = importlib.import_module(package.__name__ + ".astrbot_plugin_qzone.core.renderer.builtin_renderer")
from astrbot.core.platform.sources.aiocqhttp.aiocqhttp_message_event import AiocqhttpMessageEvent


class QQEvent(AiocqhttpMessageEvent):
    def __init__(self, admin=True):
        self.role = "admin" if admin else "member"
        self.bot = types.SimpleNamespace(set_qq_profile=AsyncMock(), call_action=AsyncMock())
        self.session = "fixture-qq:FriendMessage:12345"
        self.message_str = "fixture request"
    def get_sender_id(self):
        return "12345"


class WebEvent:
    def is_admin(self):
        return True
    def plain_result(self, value):
        return value


class ManagedQQTests(unittest.IsolatedAsyncioTestCase):
    async def test_profile_rejects_web_and_nonadmin_before_avatar_io(self):
        plugin = profile.QQProfilePlugin.__new__(profile.QQProfilePlugin)
        for event in [WebEvent(), QQEvent(admin=False)]:
            result = await plugin._set_avatar_from_event(event)
            self.assertIn("未执行", result)

    async def test_profile_uses_current_admin_qq_client(self):
        plugin = profile.QQProfilePlugin.__new__(profile.QQProfilePlugin)
        event = QQEvent()
        results = [value async for value in plugin.set_nickname(event, "Fixture")]
        self.assertEqual(len(results), 1)
        event.bot.set_qq_profile.assert_awaited_once_with(nickname="Fixture")

    async def test_native_persona_management_cannot_bypass_miobot_scope(self):
        plugin = profile.QQProfilePlugin.__new__(profile.QQProfilePlugin)
        event = QQEvent()
        for method, args in [(plugin.list_persona, (event,)), (plugin.change_persona, (event, "other-persona"))]:
            results = [value async for value in method(*args)]
            self.assertEqual(len(results), 1)
            self.assertIn("MioBot", str(results[0]))

    async def test_signature_does_not_fallback_to_another_account(self):
        plugin = signature.DafeiyuSignature.__new__(signature.DafeiyuSignature)
        plugin.conf = {"owner_session": ""}
        plugin.context = types.SimpleNamespace(platform_manager=Mock(side_effect=AssertionError("must not search platforms")))
        self.assertFalse(plugin._is_owner(WebEvent()))
        self.assertIsNone(plugin._client(WebEvent()))
        event = QQEvent()
        self.assertIs(plugin._client(event), event.bot)
        self.assertIsNone(plugin._client(QQEvent(admin=False)))

    async def test_signature_success_only_after_current_gateway_accepts(self):
        plugin = signature.DafeiyuSignature.__new__(signature.DafeiyuSignature)
        plugin.conf = {"owner_session": ""}
        plugin.history_path = str(Path(TEMP) / "signature/history.json")
        event = QQEvent()
        result = await plugin.set_signature(event, "Fixture signature", True)
        self.assertIn("改成", result)
        event.bot.call_action.assert_awaited_once_with("set_self_longnick", longNick="Fixture signature")
        event.bot.call_action.side_effect = RuntimeError("offline fixture")
        result = await plugin.set_signature(event, "Another fixture", True)
        self.assertIn("没改成", result)
        self.assertEqual(len(plugin._load()), 1)

    async def test_qzone_refuses_web_and_nonowner_without_service_access(self):
        plugin = qzone.QzonePlugin.__new__(qzone.QzonePlugin)
        for event in [WebEvent(), QQEvent(admin=False)]:
            self.assertIn("未执行", await plugin.llm_publish_feed(event, "Fixture", False))
            self.assertIn("未执行", await plugin.llm_view_feed(event))

    async def test_qzone_admin_uses_event_gateway_and_configured_service(self):
        plugin = qzone.QzonePlugin.__new__(qzone.QzonePlugin)
        plugin.cfg = types.SimpleNamespace(client=None)
        post = types.SimpleNamespace(text="Fixture", images=[])
        plugin.service = types.SimpleNamespace(publish_post=AsyncMock(return_value=post))
        plugin.sender = types.SimpleNamespace(send_post=AsyncMock())
        event = QQEvent()
        result = await plugin.llm_publish_feed(event, "Fixture", False)
        self.assertIs(plugin.cfg.client, event.bot)
        self.assertIn("已发布", result)
        plugin.service.publish_post.assert_awaited_once_with(text="Fixture", images=[])

    async def test_qzone_no_implicit_timer_page_or_campus_wall(self):
        plugin = qzone.QzonePlugin.__new__(qzone.QzonePlugin)
        plugin.db = types.SimpleNamespace(initialize=AsyncMock())
        plugin.auto_comment = plugin.auto_publish = None
        plugin.cfg = types.SimpleNamespace(_data={},client=None,trigger=types.SimpleNamespace(comment_cron="* * * * *",publish_cron="* * * * *"))
        plugin.context = types.SimpleNamespace(register_web_api=Mock(side_effect=AssertionError("managed pages disabled")),get_platform=Mock(side_effect=AssertionError("no fallback platform")))
        plugin._register_page_web_apis()
        self.assertIsNone(plugin._capture_page_client())
        with patch.object(qzone,"AutoComment",side_effect=AssertionError("timer must not run")), patch.object(qzone,"AutoPublish",side_effect=AssertionError("timer must not run")):
            await plugin.initialize()
        self.assertIsNone(await plugin.contribute_post(QQEvent()))

    async def test_qzone_text_fallback_and_strict_json_without_optional_dependencies(self):
        with patch.dict(sys.modules,{"apilmoji":None}):
            card = renderer.BuiltinQzoneCardRenderer(types.SimpleNamespace())
            self.assertIsNone(await card.render_text("Fixture"))
            self.assertIsNone(await card.render_post(object()))
        with patch.object(parser,"json5",None):
            self.assertEqual(parser.QzoneParser.parse_response('callback({"code":0,"data":{}})')["code"], 0)
            self.assertNotEqual(parser.QzoneParser.parse_response("callback({code: __import__('os').system('whoami')})")["code"], 0)

    async def test_first_install_defaults_disable_unrequested_global_side_effects(self):
        base = ROOT / "integrations/cloud-plugins"
        q = json.loads((base / "astrbot_plugin_qzone/MIOBOT_DEFAULTS.json").read_text())
        self.assertEqual(q["trigger"]["publish_cron"], "")
        self.assertEqual(q["trigger"]["comment_cron"], "")
        self.assertEqual(q["trigger"]["read_prob"], 0)
        self.assertFalse(q["trigger"]["like_when_comment"])
        self.assertFalse(q["miobot_enable_campus_wall"])
        s = json.loads((base / "astrbot_plugin_dafeiyu_signature/MIOBOT_DEFAULTS.json").read_text())
        self.assertFalse(s["self_change_hint"])
        for name in ["astrbot_plugin_qzone","astrbot_plugin_qqprofile","astrbot_plugin_dafeiyu_signature"]:
            self.assertTrue((base / name / "LICENSE").is_file())


if __name__ == "__main__":
    try:
        unittest.main()
    finally:
        shutil.rmtree(TEMP, ignore_errors=True)
