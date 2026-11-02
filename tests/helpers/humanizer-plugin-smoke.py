"""Real pinned AstrBot import and actual plugin hooks, no server/model calls.

Run using the managed Python interpreter, with the source runtime on PYTHONPATH.
The temporary root is created before importing AstrBot; existing data is not read.
"""
from __future__ import annotations

import asyncio
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import time
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
TEMP = Path(tempfile.mkdtemp(prefix="miobot-humanizer-hooks-"))
os.environ["ASTRBOT_ROOT"] = str(TEMP)
os.environ["MIOBOT_MANAGED_PERSONALITY"] = "1"
sys.path.insert(0, str(ROOT / ".runtime/astrbot-source"))
PLUGIN = ROOT / "integrations/humanizer/astrbot_plugin_wanna_be_human"
sys.path.insert(0, str(PLUGIN))

from astrbot.core.provider.entities import ProviderRequest, LLMResponse
from miobot_humanizer_compat import prepare_scope, state_key

spec = importlib.util.spec_from_file_location("miobot_test_humanizer", PLUGIN / "main.py")
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)


def defaults(schema):
    return {
        k: defaults(v.get("items", {})) if v.get("type") == "object" else v.get("default")
        for k, v in schema.items()
    }


class Config(dict):
    def save_config(self):
        pass

    async def save_config_async(self):
        pass


class Event:
    def __init__(self, sender="test-user", session="native-a", persona="pa-test-companion"):
        self.extra = {}
        self.sender = sender
        self.session_id = session
        self.persona = persona
        self.unified_msg_origin = f"webchat:FriendMessage:webchat!{sender}!{session}"
        self.message_str = "今天有点累，先陪我安静待一会儿。"

    def get_extra(self, key, default=None):
        return self.extra.get(key, default)

    def set_extra(self, key, value):
        self.extra[key] = value

    def get_sender_id(self):
        return self.sender

    def get_platform_name(self):
        return "webchat"

    def get_message_type(self):
        return "FriendMessage"


class Context:
    def __init__(self):
        self.current = SimpleNamespace(cid="test-cid", persona_id="pa-test-companion")
        self.conversation_manager = self
        self.persona_manager = self
        self.llm_calls = 0

    async def get_curr_conversation_id(self, origin):
        return self.current.cid

    async def get_conversation(self, origin, cid):
        return self.current

    async def resolve_selected_persona(self, *, conversation_persona_id, **kwargs):
        pid = conversation_persona_id
        return pid, {"name": pid} if pid else None, None, False

    def get_config(self, **kwargs):
        return {"provider_settings": {"datetime_system_prompt": False}}

    def get_all_providers(self):
        return []

    def register_web_api(self, *args, **kwargs):
        pass

    async def llm_generate(self, *args, **kwargs):
        self.llm_calls += 1
        raise AssertionError("No model call is allowed in the hook smoke")


async def main():
    config = Config(defaults(json.loads((PLUGIN / "_conf_schema.json").read_text())))
    patch = json.loads((ROOT / "integrations/humanizer/MIOBOT_DEFAULTS.json").read_text())
    for group, values in patch.items():
        config[group].update(values)
    ctx = Context()
    plugin = module.HumanizerPlugin(ctx, config)
    await plugin.initialize()
    try:
        assert plugin._proactive_task is None and plugin._style_task is None and plugin._life_task is None
        assert not plugin._cfg("enable_retrieval", True)
        assert not plugin._cfg("auto_build_default", True)
        assert not plugin._life("enable_life", True)
        event = Event()
        request = ProviderRequest(prompt=event.message_str, system_prompt="BASE PERSONA", conversation=ctx.current)
        assert await prepare_scope(ctx, event, request)
        key = state_key(event)
        plugin._last_seen[key] = time.time() - 7200
        plugin._emotions[key] = {"emotion": "appy", "intensity": 0.3, "ts": time.time()}
        await plugin.on_llm_request(event, request)
        parts = "\n".join(str(getattr(p, "text", p)) for p in request.extra_user_content_parts)
        assert "【人类对话风格】" in request.system_prompt
        assert "<time_context>" in parts
        assert "2小时" in parts or "2 小时" in parts
        assert "当前状态" not in parts and "咖啡店" not in parts
        assert "不自称 AI" not in request.system_prompt + parts
        assert "如被问身份，如实说是AI" in request.system_prompt

        # Same account and physical session, different persona: no shared state.
        other = Event(persona="pa-test-game")
        other_conversation = SimpleNamespace(cid="test-cid", persona_id=other.persona)
        ctx.current = other_conversation
        other_request = ProviderRequest(prompt=other.message_str, system_prompt="OTHER PERSONA", conversation=other_conversation)
        await plugin.on_llm_request(other, other_request)
        other_key = state_key(other)
        assert other_key and other_key != key
        assert plugin._prev_seen.get(other_key) is None
        assert plugin._emotion_state(other_key)["emotion"] == "neutral"
        assert "2小时" not in "\n".join(str(getattr(p, "text", p)) for p in other_request.extra_user_content_parts)

        for changed in [Event(sender="another-user"), Event(session="native-b")]:
            ctx.current = SimpleNamespace(cid="test-cid", persona_id=changed.persona)
            assert await prepare_scope(ctx, changed)
            assert state_key(changed) not in {key, other_key}

        ctx.current = SimpleNamespace(cid="test-cid", persona_id=None)
        missing = Event(persona=None)
        missing_request = ProviderRequest(prompt="hello", system_prompt="UNCHANGED", conversation=ctx.current)
        await plugin.on_llm_request(missing, missing_request)
        assert not state_key(missing)
        assert missing_request.system_prompt == "UNCHANGED" and not missing_request.extra_user_content_parts
        unknown_user = Event(sender="")
        assert not await prepare_scope(ctx, unknown_user)

        response = LLMResponse(role="assistant", completion_text="值得注意的是，今天可以先休息。希望这对你有帮助。")
        await plugin.humanize_response(event, response)
        assert "值得注意的是" not in response.completion_text
        disclosure = LLMResponse(role="assistant", completion_text="我是AI。我的知识截止日期2025年1月，因此无法确认最新消息。")
        await plugin.humanize_response(event, disclosure)
        assert "我是AI" in disclosure.completion_text and "2025年1月" in disclosure.completion_text
        code = "```python\nprint('值得注意的是')\n```"
        code_response = LLMResponse(role="assistant", completion_text=code)
        await plugin.humanize_response(event, code_response)
        assert code_response.completion_text == code

        for name, args in [("_call_llm_for_timeline", ("test",)), ("_call_llm_for_profile", ("test", None)), ("_ensure_kb", ("test", "test"))]:
            try:
                await getattr(plugin, name)(*args)
            except RuntimeError:
                pass
            else:
                raise AssertionError(f"{name} must refuse managed auxiliary calls")
        assert ctx.llm_calls == 0
        print(json.dumps({"success": True, "engine": "real pinned AstrBot 4.29.3 imports", "plugin": "wanna_be_human 4.1.9 + MioBot integration", "actualRequestHook": True, "actualResponseCleanup": True, "personaUserSessionIsolation": True, "missingScopeFailsClosed": True, "identityAndKnowledgeLimitsPreserved": True, "codeUnchanged": True, "automaticExtraCallsDisabled": True, "paidRequests": 0}, ensure_ascii=False))
    finally:
        await plugin.terminate()


try:
    asyncio.run(main())
finally:
    shutil.rmtree(TEMP, ignore_errors=True)
