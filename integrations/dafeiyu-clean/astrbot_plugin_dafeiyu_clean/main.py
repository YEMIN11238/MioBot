"""大肥鱼回复防串台 — zexuan604 original, adapted for MioBot/AstrBot 4.29.3.

Original hook responsibilities and marker rules are retained. Compatibility
changes are documented in NOTICE.md; untouched source is retained separately.
No user/system/tool message is rewritten, and an explicit active profile plugin
allow-list is required. Cleaning completed responses does not by itself guard
already-emitted streaming deltas: MioBot must guard its own streaming boundary.
"""
from astrbot import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.message_components import Plain
from astrbot.api.star import Context, Star

from .clean import clean

NAME = "astrbot_plugin_dafeiyu_clean"


def _allowed(event: AstrMessageEvent) -> bool:
    names = getattr(event, "plugins_name", None)
    return isinstance(names, list) and (NAME in names or names == ["*"])


def _clean_content(content):
    """AstrBot 4.29.3 strings, OpenAI text dicts, and native TextParts."""
    if isinstance(content, str):
        result = clean(content)
        return result, result != content
    changed = False
    if isinstance(content, list):
        for part in content:
            if isinstance(part, dict) and part.get("type") == "text" and isinstance(part.get("text"), str):
                before = part["text"]
                part["text"] = clean(before)
                changed |= part["text"] != before
            elif getattr(part, "type", None) == "text" and isinstance(getattr(part, "text", None), str):
                before = part.text
                part.text = clean(before)
                changed |= part.text != before
    return content, changed


def _clean_response(resp) -> bool:
    """Keep rich message-chain ordering instead of collapsing Plain parts."""
    if resp is None or getattr(resp, "role", None) != "assistant":
        return False
    result_chain = getattr(resp, "result_chain", None)
    if result_chain is not None:
        changed = False
        for part in result_chain.chain:
            if isinstance(part, Plain):
                before = part.text
                part.text = clean(before)
                changed |= part.text != before
        return changed
    text = getattr(resp, "completion_text", None)
    if isinstance(text, str):
        cleaned = clean(text)
        if cleaned != text:
            resp.completion_text = cleaned
            return True
    return False


class DafeiyuClean(Star):
    def __init__(self, context: Context) -> None:
        super().__init__(context)

    @filter.on_llm_request(priority=100000)
    async def clean_history(self, event: AstrMessageEvent, req):
        if not _allowed(event):
            return
        count = 0
        for message in getattr(req, "contexts", None) or []:
            if isinstance(message, dict) and message.get("role") == "assistant":
                message["content"], changed = _clean_content(message.get("content"))
                count += changed
        if count:
            logger.info("[dafeiyu_clean] 历史助手回复已清理内部标记")

    @filter.on_llm_response(priority=100000)
    async def clean_response(self, event: AstrMessageEvent, resp):
        if _allowed(event):
            _clean_response(resp)

    @filter.on_agent_done(priority=100000)
    async def clean_saved(self, event: AstrMessageEvent, run_context, llm_response):
        if not _allowed(event):
            return
        # 4.29.3 MainAgentHooks supplies ContextWrapper.messages: list[Message].
        # Clean all assistant context entries, never system/user/tool/checkpoint.
        for message in getattr(run_context, "messages", None) or []:
            if getattr(message, "role", None) == "assistant":
                message.content, _ = _clean_content(message.content)
        _clean_response(llm_response)

    @filter.on_decorating_result(priority=100000)
    async def clean_outgoing(self, event: AstrMessageEvent):
        if not _allowed(event):
            return
        result = event.get_result()
        if result is None or not result.chain or not result.is_model_result():
            return
        new_chain, changed = [], False
        for part in result.chain:
            if isinstance(part, Plain):
                before = part.text
                part.text = clean(before)
                changed |= part.text != before
                if not part.text:
                    continue
            new_chain.append(part)
        if changed:
            result.chain = new_chain
            logger.info("[dafeiyu_clean] 待发送助手回复已清理内部标记")
