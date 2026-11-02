"""Real AstrBot 4.29.3 hook/class compatibility, local data only, no model API.

Run with the pinned runtime Python. All event/provider/context objects below are
real native classes; the local objects contain synthetic test text only.
"""
import atexit
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = ROOT / "integrations/dafeiyu-clean/astrbot_plugin_dafeiyu_clean"
sys.dont_write_bytecode = True
isolated = tempfile.TemporaryDirectory(prefix="miobot-clean-native-")
atexit.register(isolated.cleanup)
os.environ["ASTRBOT_ROOT"] = isolated.name
os.chdir(isolated.name)
sys.path.insert(0, str(ROOT / ".runtime/astrbot-source"))

from astrbot.core.agent.message import ImageURLPart, Message, TextPart, ThinkPart, ToolCall
from astrbot.core.agent.run_context import ContextWrapper
from astrbot.core.astr_agent_hooks import MainAgentHooks
from astrbot.core.message.components import At, Plain
from astrbot.core.message.message_event_result import MessageChain, MessageEventResult, ResultContentType
from astrbot.core.pipeline.context_utils import call_event_hook
from astrbot.core.platform.astr_message_event import AstrMessageEvent
from astrbot.core.platform.astrbot_message import AstrBotMessage, MessageMember
from astrbot.core.platform.message_type import MessageType
from astrbot.core.platform.platform_metadata import PlatformMetadata
from astrbot.core.provider.entities import LLMResponse, ProviderRequest
from astrbot.core.star.filter.platform_adapter_type import ADAPTER_NAME_2_TYPE
from astrbot.core.star.star import star_map
from astrbot.core.star.star_handler import EventType, star_handlers_registry
import yaml

package = ModuleType("miobot_clean_fixture")
package.__path__ = [str(PLUGIN)]
sys.modules[package.__name__] = package
spec = importlib.util.spec_from_file_location(package.__name__ + ".main", PLUGIN / "main.py")
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
clean = sys.modules[package.__name__ + ".clean"].clean
metadata = star_map[module.__name__]
metadata.name = module.NAME
metadata.activated = True
instance = module.DafeiyuClean(SimpleNamespace())
# Apply the same bound-instance step performed by the native plugin loader.
for handler in star_handlers_registry.get_handlers_by_module_name(module.__name__):
    handler.handler = getattr(instance, handler.handler_name)

RAW = "在呢 <system_reminder>User ID: 123, Nickname: fixture</system_reminder>\n<｜DSML｜function_calls><｜DSML｜invoke name=\"tool\">secret</｜DSML｜invoke></｜DSML｜function_calls>"


def event(plugins=None, platform="webchat"):
    message = AstrBotMessage()
    message.type = MessageType.FRIEND_MESSAGE
    message.self_id = "fixture-bot"
    message.session_id = "fixture-user"
    message.message_id = "fixture-message"
    message.sender = MessageMember(user_id="fixture-user", nickname="fixture")
    message.message = [Plain(RAW)]
    message.message_str = RAW
    message.raw_message = {}
    item = AstrMessageEvent(RAW, message, PlatformMetadata(platform, "isolated test", platform), "fixture-session")
    item.plugins_name = [module.NAME] if plugins is None else plugins
    return item


class Rules(unittest.TestCase):
    def test_original_markers_are_removed(self):
        self.assertEqual(clean(RAW), "在呢")
        self.assertEqual(clean("好<tool_call>{\"x\":1}</tool_call>啦"), "好啦")
        self.assertEqual(clean("嗯</｜DSML｜parameter>"), "嗯")
        self.assertEqual(clean("在<｜tool▁calls▁begin｜>hidden<｜tool▁calls▁end｜>"), "在")
        self.assertEqual(clean("好 <system_reminder>unfinished\n下一句"), "好 \n下一句")
        self.assertEqual(clean("回答<system_reminder>秘密`payload`</system_reminder>继续"), "回答继续")
        self.assertEqual(clean('回答<tool_call>{"msg":"`secret`"}</tool_call>继续'), "回答继续")

    def test_fenced_and_inline_code_are_preserved(self):
        code = '```python\nprint("<system_reminder>example</system_reminder>")\nprint("<tool_call>sample</tool_call>")\n```'
        self.assertEqual(clean(code), code)
        inline = '代码里用 `<tool_call>` 和 `<｜DSML｜function_calls>` 作为字符串'
        self.assertEqual(clean(inline), inline)
        mixed = code + "\n正常回复<system_reminder>hidden</system_reminder>"
        self.assertEqual(clean(mixed), code + "\n正常回复")
        tildes = '~~~json\n{"field":"<system_reminder>example</system_reminder>"}\n~~~~\n回复<tool_call>hidden</tool_call>'
        self.assertEqual(clean(tildes), tildes.replace("<tool_call>hidden</tool_call>", ""))

    def test_normal_technical_text_is_unchanged(self):
        text = '  <div class="card">你好</div>\nfunction tool_call() { return "DSML"; }\n'
        self.assertEqual(clean(text), text)
        self.assertEqual(clean("不懂可以说不知道\n不要报内部编号"), "不懂可以说不知道\n不要报内部编号")

    def test_metadata_covers_every_known_native_adapter(self):
        meta = yaml.safe_load((PLUGIN / "metadata.yaml").read_text())
        self.assertEqual(set(meta["support_platforms"]), set(ADAPTER_NAME_2_TYPE))
        self.assertIn("webchat", meta["support_platforms"])


class NativeHooks(unittest.IsolatedAsyncioTestCase):
    async def test_request_hook_edits_assistant_history_only(self):
        req = ProviderRequest(prompt=RAW, system_prompt=RAW, contexts=[
            {"role":"system", "content":RAW}, {"role":"user", "content":RAW},
            {"role":"tool", "content":RAW, "tool_call_id":"fixture-tool"},
            {"role":"assistant", "content":RAW},
            {"role":"assistant", "content":[{"type":"text", "text":RAW}, {"type":"image_url", "image_url":{"url":"https://example.invalid/x.png"}}]},
        ])
        await call_event_hook(event(), EventType.OnLLMRequestEvent, req)
        self.assertEqual(req.prompt, RAW)
        self.assertEqual(req.system_prompt, RAW)
        self.assertEqual([item["content"] for item in req.contexts[:3]], [RAW] * 3)
        self.assertEqual(req.contexts[3]["content"], "在呢")
        self.assertEqual(req.contexts[4]["content"][0]["text"], "在呢")
        self.assertEqual(req.contexts[4]["content"][1]["type"], "image_url")

    async def test_native_done_hook_cleans_response_and_saved_textparts(self):
        evt = event()
        tool = ToolCall(id="tool", function=ToolCall.FunctionBody(name="fixture", arguments=json.dumps({"raw":RAW})))
        messages = [Message(role="system", content=RAW), Message(role="user", content=RAW),
                    Message(role="tool", content=RAW, tool_call_id="tool"),
                    Message(role="assistant", content=RAW, tool_calls=[tool]),
                    Message(role="assistant", content=[TextPart(text=RAW), ThinkPart(think=RAW), ImageURLPart(image_url=ImageURLPart.ImageURL(url="https://example.invalid/x.png"))])]
        run = ContextWrapper(context=SimpleNamespace(event=evt), messages=messages)
        response = LLMResponse(role="assistant", completion_text=RAW)
        await MainAgentHooks().on_agent_done(run, response)
        self.assertEqual(response.completion_text, "在呢")
        self.assertEqual([item.content for item in run.messages[:3]], [RAW] * 3)
        self.assertEqual(run.messages[3].content, "在呢")
        self.assertEqual(run.messages[3].tool_calls[0].function.arguments, tool.function.arguments)
        self.assertEqual(run.messages[4].content[0].text, "在呢")
        self.assertEqual(run.messages[4].content[1].think, RAW)
        self.assertIsInstance(run.messages[4].content[2], ImageURLPart)

    async def test_rich_response_order_and_non_assistant_response_are_preserved(self):
        mention = At(qq="fixture")
        response = LLMResponse(role="assistant", result_chain=MessageChain(chain=[Plain(RAW), mention, Plain("后一句")]))
        await call_event_hook(event(), EventType.OnLLMResponseEvent, response)
        self.assertEqual(response.result_chain.chain[0].text, "在呢")
        self.assertIs(response.result_chain.chain[1], mention)
        self.assertEqual(response.result_chain.chain[2].text, "后一句")
        other = LLMResponse(role="tool", completion_text=RAW)
        await call_event_hook(event(), EventType.OnLLMResponseEvent, other)
        self.assertEqual(other.completion_text, RAW)

    async def test_unselected_or_unknown_profile_is_untouched(self):
        for plugins in ([], ["another-plugin"], None):
            evt = event([])
            evt.plugins_name = plugins
            response = LLMResponse(role="assistant", completion_text=RAW)
            req = ProviderRequest(contexts=[{"role":"assistant", "content":RAW}])
            run = ContextWrapper(context=SimpleNamespace(event=evt), messages=[Message(role="assistant", content=RAW)])
            await call_event_hook(evt, EventType.OnLLMRequestEvent, req)
            await MainAgentHooks().on_agent_done(run, response)
            self.assertEqual(req.contexts[0]["content"], RAW)
            self.assertEqual(response.completion_text, RAW)
            self.assertEqual(run.messages[0].content, RAW)

    async def test_outgoing_hook_cleans_model_results_only_and_supports_other_channels(self):
        for platform in ("webchat", "aiocqhttp", "discord", "telegram"):
            evt = event(platform=platform)
            evt.set_result(MessageEventResult(chain=[Plain(RAW)], result_content_type=ResultContentType.LLM_RESULT))
            await call_event_hook(evt, EventType.OnDecoratingResultEvent)
            self.assertEqual(evt.get_result().chain[0].text, "在呢")
        evt = event()
        evt.set_result(MessageEventResult(chain=[Plain(RAW)]))
        await call_event_hook(evt, EventType.OnDecoratingResultEvent)
        self.assertEqual(evt.get_result().chain[0].text, RAW)


if __name__ == "__main__":
    unittest.main(verbosity=2)
