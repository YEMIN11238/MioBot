"""MioBot-only collection boundary; no credentials or configured owner ships here."""
from __future__ import annotations
import os
import re

def managed_mode():
    return os.environ.get("MIOBOT_MANAGED_CLOUD_PLUGINS") == "1"

def normalized_collection(config):
    result = dict(config)
    if managed_mode():
        owner = str(result.get("owner_qq") or "").strip()
        origin = str(result.get("owner_umo") or "").strip()
        configured = bool(re.fullmatch(r"[0-9]+", owner) and re.fullmatch(r"[^:\s]+:FriendMessage:" + owner, origin))
        result["enabled"] = result.get("enabled") is True and configured
        result["only_platform_stickers"] = True
        result["owner_qq"], result["owner_umo"] = owner, origin
    return result

def allowed_collection_source(event, config):
    """Fail closed on another QQ account, group, platform, cron or missing owner."""
    owner = str(config.get("owner_qq") or "").strip()
    origin = str(config.get("owner_umo") or "").strip()
    if not re.fullmatch(r"[0-9]+", owner) or not re.fullmatch(r"[^:\s]+:FriendMessage:" + owner, origin):
        return False
    try:
        return bool(event.is_private_chat() and event.get_platform_name() == "aiocqhttp"
            and str(event.get_sender_id()) == owner
            and event.get_platform_id() == origin.split(":", 1)[0]
            and str(event.unified_msg_origin) == origin
            and type(event).__name__ != "CronMessageEvent"
            and event.get_extra("cron_job") is None and event.get_extra("cron_payload") is None)
    except Exception:
        return False
