"""Real pinned AstrBot imports and isolated collection boundaries, zero network."""
import asyncio
import copy
import importlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

REPO = Path(__file__).resolve().parents[2]
TEMP = tempfile.TemporaryDirectory(prefix="miobot-stickers-")
os.environ["ASTRBOT_ROOT"] = TEMP.name
os.environ["MIOBOT_MANAGED_CLOUD_PLUGINS"] = "1"
sys.path[:0] = [str(REPO / ".runtime/astrbot-source"), str(REPO / "integrations/cloud-plugins")]
policy = importlib.import_module("meme_manager.miobot_policy")
mm = importlib.import_module("meme_manager.main")
collection = importlib.import_module("meme_manager.backend.auto_collect")
bili = importlib.import_module("astrbot_plugin_bilibili_basic_stickers.main")
bili_core = importlib.import_module("astrbot_plugin_bilibili_basic_stickers.core")

CONFIG = {"enabled": True, "owner_qq": "10001", "owner_umo": "fixture:FriendMessage:10001"}

class Event:
    def __init__(self, sender="10001", private=True, platform="aiocqhttp", channel="fixture", origin=None, marked=True):
        self.sender, self.private, self.platform, self.channel = sender, private, platform, channel
        self.unified_msg_origin = origin or f"{channel}:FriendMessage:{sender}"
        self.message_obj = SimpleNamespace(message=[collection.Image.fromFileSystem(Path(TEMP.name) / "test.png")],raw_message={"message":[{"type":"image","data":{"sub_type":1 if marked else 0}}]})
    def is_private_chat(self): return self.private
    def get_sender_id(self): return self.sender
    def get_group_id(self): return "group"
    def get_session_id(self): return self.sender
    def get_platform_name(self): return self.platform
    def get_platform_id(self): return self.channel
    def get_extra(self, key): return None

class StickerTests(unittest.IsolatedAsyncioTestCase):
    def test_real_plugins_import_with_optional_r2_dependency_absent(self):
        self.assertTrue(issubclass(mm.MemeSender, mm.Star))
        self.assertTrue(issubclass(bili.BilibiliBasicStickers, bili.Star))
        # An unavailable optional backend no longer prevents base plugin import.
        source = (REPO / "integrations/cloud-plugins/meme_manager/image_host/providers/cloudflare_r2_provider.py").read_text()
        self.assertIn("            from minio import Minio", source)

    async def test_default_constructor_registers_host_apis_without_worker_or_remote_sync(self):
        routes=[]
        context=SimpleNamespace(register_web_api=lambda *args:routes.append(args),provider_manager=SimpleNamespace(personas=[]))
        plugin=mm.MemeSender(context,{})
        try:
            await plugin.initialize()
            self.assertTrue(routes)
            self.assertTrue(all(route[0].startswith("/meme_manager/") for route in routes))
            self.assertIsNone(plugin.img_sync)
            self.assertIsNone(plugin.auto_collect_manager._worker_task)
            self.assertFalse(plugin.auto_collect_manager.enabled)
            collector=bili.BilibiliBasicStickers(context,{})
            self.assertFalse(collector._tasks)
            await collector.terminate()
        finally:await plugin.terminate()

    def test_missing_owner_disables_collection_and_platform_markers_are_mandatory(self):
        for value in [{"enabled":True},{**CONFIG,"owner_umo":"other:GroupMessage:10001"},{**CONFIG,"owner_qq":""}]:
            self.assertFalse(policy.normalized_collection(value)["enabled"])
        hardened = policy.normalized_collection({**CONFIG,"only_platform_stickers":False})
        self.assertTrue(hardened["enabled"])
        self.assertTrue(hardened["only_platform_stickers"])

    def test_exact_private_owner_platform_and_origin_required(self):
        self.assertTrue(policy.allowed_collection_source(Event(), CONFIG))
        for event in [Event(sender="10002"),Event(private=False),Event(platform="webchat"),Event(channel="another"),Event(origin="fixture:FriendMessage:10002")]:
            self.assertFalse(policy.allowed_collection_source(event, CONFIG))
        cron=Event();cron.get_extra=lambda key:{} if key=="cron_job" else None
        self.assertFalse(policy.allowed_collection_source(cron, CONFIG))

    async def test_real_manager_does_not_collect_an_ordinary_photo(self):
        plugin = SimpleNamespace(_resolve_runtime_pack_context=lambda **kw:{"pack_id":"private-fixture","category_mapping":{"happy":"开心"}})
        manager=collection.AutoCollectManager(plugin,CONFIG)
        manager._ready=True
        manager._snapshot_message_images=AsyncMock(return_value=True)
        try:
            self.assertFalse(await manager.submit(Event(marked=False)))
            manager._snapshot_message_images.assert_not_called()
            self.assertEqual(manager.counters["unmarked_image"],1)
            self.assertTrue(await manager.submit(Event(marked=True)))
            manager._snapshot_message_images.assert_awaited_once()
        finally:await manager.close()

    async def test_real_manager_rejects_other_senders_and_groups_before_snapshot(self):
        manager=collection.AutoCollectManager(SimpleNamespace(),CONFIG)
        manager._ready=True
        manager._snapshot_message_images=AsyncMock(return_value=True)
        try:
            self.assertFalse(await manager.submit(Event(sender="10002")))
            self.assertFalse(await manager.submit(Event(private=False)))
            manager._snapshot_message_images.assert_not_called()
        finally:await manager.close()

    def test_native_registration_defaults_no_collection_or_remote_sync(self):
        schema=json.loads((REPO/"integrations/cloud-plugins/meme_manager/_conf_schema.json").read_text())
        self.assertFalse(schema["auto_collect"]["items"]["enabled"]["default"])
        self.assertEqual(schema["auto_collect"]["items"]["owner_qq"]["default"],"")
        self.assertTrue(schema["auto_collect"]["items"]["only_platform_stickers"]["default"])
        self.assertTrue(schema["storage"]["items"]["providers"]["items"]["cloudflare_r2"]["items"]["secret_access_key"]["_secret"])

    def test_managed_prompt_updates_do_not_rewrite_another_persona(self):
        plugin=object.__new__(mm.MemeSender)
        persona={"id":"other-persona","prompt":"another assistant's prompt"}
        plugin.context=SimpleNamespace(provider_manager=SimpleNamespace(personas=[persona]))
        plugin.sys_prompt_add="old"
        before=copy.deepcopy(persona)
        plugin._apply_persona_prompts()
        self.assertEqual(persona,before)
        self.assertEqual(plugin.sys_prompt_add,"")

    def test_bilibili_catalog_only_contains_eleven_fixed_public_entries_and_empty_owner(self):
        self.assertEqual(len(bili_core.CATALOG),11)
        schema=json.loads((REPO/"integrations/cloud-plugins/astrbot_plugin_bilibili_basic_stickers/_conf_schema.json").read_text())
        self.assertEqual(schema["owner_qq"]["default"],"")
        self.assertEqual(schema["owner_umo"]["default"],"")
        self.assertFalse(bili_core.is_owner_event(Event(),{}))
        self.assertTrue(all(bili_core.validate_image_url(row["url"]) for row in bili_core.CATALOG))

if __name__ == "__main__":
    try:unittest.main(verbosity=2)
    finally:TEMP.cleanup()
