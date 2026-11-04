"""Pinned AstrBot imports and managed learning/forwarding guards, no network."""
import asyncio
import copy
import importlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

ROOT=Path(__file__).resolve().parents[2]
TEMP=tempfile.TemporaryDirectory(prefix="miobot-learning-smoke-")
os.environ["ASTRBOT_ROOT"]=TEMP.name
os.environ["MIOBOT_MANAGED_CLOUD_PLUGINS"]="1"
sys.path[:0]=[str(ROOT/".runtime/astrbot-source"),str(ROOT/"integrations/cloud-plugins")]
learning=importlib.import_module("astrbot_plugin_self_learning.main")
policy=importlib.import_module("astrbot_plugin_self_learning.miobot_policy")
webui=importlib.import_module("astrbot_plugin_self_learning.webui.manager")
builder=importlib.import_module("astrbot_plugin_self_learning.webui.frontend_builder")
page_api=importlib.import_module("astrbot_plugin_self_learning.core.page_api")
sowing=importlib.import_module("astrbot_sowing_discord.main")

class Event:
    def __init__(self,sender="10001",platform="aiocqhttp",channel="fixture",private=True,origin=None,group=""):
        self.sender,self.platform,self.channel,self.private,self.group=sender,platform,channel,private,group
        self.unified_msg_origin=origin or f"{channel}:FriendMessage:{sender}"
        self.message_obj=SimpleNamespace(group_id=group,message_id="99",message=[sowing.Plain("fixture")])
        self.bot=SimpleNamespace(api=SimpleNamespace(call_action=AsyncMock()))
    def get_sender_id(self):return self.sender
    def get_platform_name(self):return self.platform
    def get_platform_id(self):return self.channel
    def is_private_chat(self):return self.private
    def get_group_id(self):return self.group
    def get_extra(self,key):return None

class LearningTests(unittest.IsolatedAsyncioTestCase):
    def test_real_modules_import_and_safe_schema_defaults(self):
        self.assertTrue(issubclass(learning.SelfLearningPlugin, learning.star.Star))
        self.assertTrue(issubclass(sowing.Sowing_Discord,sowing.Star))
        schema=json.loads((ROOT/"integrations/cloud-plugins/astrbot_plugin_self_learning/_conf_schema.json").read_text())
        for key in ["enable_message_capture","enable_auto_learning","enable_realtime_learning","enable_web_interface"]:
            self.assertFalse(schema["Self_Learning_Basic"]["items"][key]["default"])
        self.assertFalse(schema["Persona_Evolution_Settings"]["items"]["auto_apply_persona_updates"]["default"])

    def test_policy_forces_actual_persona_section_and_no_standalone_webui(self):
        config={"miobot_owner_umo":"fixture:FriendMessage:10001","Self_Learning_Basic":{"enable_message_capture":True,"enable_auto_learning":True,"enable_web_interface":True},"Persona_Evolution_Settings":{"enable_persona_evolution":True,"use_persona_manager_updates":True,"auto_apply_persona_updates":True},"Advanced_Settings":{"auto_apply_approved_persona":True},"Storage_Settings":{"data_dir":"/outside"}}
        result=policy.apply_managed_config(config)
        self.assertTrue(result["Self_Learning_Basic"]["enable_message_capture"])
        self.assertFalse(result["Self_Learning_Basic"]["enable_web_interface"])
        self.assertTrue(all(result["Persona_Evolution_Settings"][key] is False for key in ["enable_persona_evolution","use_persona_manager_updates","auto_apply_persona_updates"]))
        self.assertFalse(result["Advanced_Settings"]["auto_apply_approved_persona"])
        self.assertEqual(result["Storage_Settings"]["data_dir"],"")
        parsed=learning.PluginConfig.create_from_runtime_sources(result,data_dir=TEMP.name,config_file=str(Path(TEMP.name)/"config-not-written.json"))
        self.assertFalse(parsed.enable_web_interface)
        self.assertFalse(parsed.auto_apply_persona_updates)
        self.assertFalse(parsed.use_persona_manager_updates)
        self.assertFalse(parsed.enable_persona_evolution)

    def test_missing_or_malformed_owner_disables_capture_and_learning(self):
        for owner in ["","not-a-umo","fixture:GroupMessage:10001"]:
            config={"miobot_owner_umo":owner,"Self_Learning_Basic":{"enable_message_capture":True,"enable_auto_learning":True,"enable_realtime_learning":True}}
            result=policy.apply_managed_config(config)
            self.assertTrue(all(result["Self_Learning_Basic"][key] is False for key in ["enable_message_capture","enable_auto_learning","enable_realtime_learning"]))

    def test_only_exact_private_owner_channel_sender_is_accepted(self):
        config={"miobot_owner_umo":"fixture:FriendMessage:10001"}
        self.assertTrue(policy.accepts_owner(Event(),config))
        for event in [Event(sender="10002"),Event(platform="webchat"),Event(channel="other"),Event(private=False),Event(group="20"),Event(origin="fixture:FriendMessage:10002")]:
            self.assertFalse(policy.accepts_owner(event,config))
        cron=Event();cron.get_extra=lambda k:{} if k=="cron_payload" else None
        self.assertFalse(policy.accepts_owner(cron,config))

    async def test_command_and_message_hooks_reject_another_owner_before_services(self):
        plugin=object.__new__(learning.SelfLearningPlugin)
        plugin.config={"miobot_owner_umo":"fixture:FriendMessage:10001"}
        plugin._command_handlers=Mock()
        plugin._hook_handler=Mock()
        other=Event(sender="10002")
        self.assertEqual([r async for r in plugin.start_learning_command(other)],[])
        self.assertEqual([r async for r in plugin.remember_command(other)],[])
        await plugin.on_message(other)
        plugin._command_handlers.assert_not_called()
        plugin._hook_handler.assert_not_called()

    async def test_standalone_webui_and_autobuild_are_blocked_even_if_flags_changed(self):
        manager=object.__new__(webui.WebUIManager)
        manager._config=SimpleNamespace(enable_web_interface=True)
        self.assertFalse(manager.create_server())
        await manager.immediate_start(None)
        await manager.setup_and_start()
        with patch.object(builder,"dashboard_artifact_exists",return_value=False),patch.object(builder,"_run_build_subprocess",new=AsyncMock()) as build:
            self.assertFalse(await builder.ensure_dashboard_built("missing"))
            build.assert_not_called()
        plugin=object.__new__(learning.SelfLearningPlugin)
        plugin._trigger_dashboard_autobuild()
        api=object.__new__(page_api.PluginPageApi)
        result=await api._install_dependencies({"manual_confirmed":True,"tier":"full"})
        self.assertFalse(result["success"])

    async def test_empty_or_invalid_groups_never_fetch_all_groups_or_forward(self):
        for config in [{},{"banshi_group_list":["10"],"banshi_target_list":[]},{"banshi_group_list":[" "],"banshi_target_list":["20"]},{"banshi_group_list":["10"],"banshi_target_list":[True,"*",""]}]:
            plugin=sowing.Sowing_Discord(SimpleNamespace(),config)
            event=Event(private=False,group="10")
            await plugin.handle_message(event)
            await plugin._execute_forward_and_cool(event,None,None)
            self.assertEqual(await plugin.get_group_list(event),[])
            event.bot.api.call_action.assert_not_called()
            await plugin.terminate()

    async def test_explicit_group_whitelists_only_cache_authorized_sources(self):
        plugin=sowing.Sowing_Discord(SimpleNamespace(),{"banshi_group_list":[10,"10"],"banshi_target_list":[20]})
        plugin.local_cache=SimpleNamespace(add_cache=AsyncMock(),get_waiting_messages=AsyncMock(return_value=[]))
        try:
            self.assertEqual(plugin.banshi_group_list,["10"])
            self.assertEqual(plugin.banshi_target_list,["20"])
            await plugin.handle_message(Event(private=False,group="99"))
            plugin.local_cache.add_cache.assert_not_called()
            await plugin.handle_message(Event(private=False,group="10"))
            plugin.local_cache.add_cache.assert_awaited_once_with("99")
        finally:await plugin.terminate()

if __name__=="__main__":
    try:unittest.main(verbosity=2)
    finally:TEMP.cleanup()
