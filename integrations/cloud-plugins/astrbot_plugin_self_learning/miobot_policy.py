"""MioBot-specific private-session scope and persona/hosting boundaries."""
from __future__ import annotations
import os
import re

def apply_managed_config(config):
    if os.environ.get("MIOBOT_MANAGED_CLOUD_PLUGINS") != "1":
        return config
    basic = config.setdefault("Self_Learning_Basic", {})
    for key in ("enable_message_capture", "enable_auto_learning", "enable_realtime_learning"):
        basic.setdefault(key, False)
    basic["enable_web_interface"] = False
    config.setdefault("Advanced_Settings", {})["auto_apply_approved_persona"] = False
    evolution = config.setdefault("Persona_Evolution_Settings", {})
    evolution.update({"enable_persona_evolution": False, "use_persona_manager_updates": False, "auto_apply_persona_updates": False})
    config.setdefault("Storage_Settings", {})["data_dir"] = ""
    origin = str(config.get("miobot_owner_umo") or "").strip()
    if re.fullmatch(r"[^:\s]+:FriendMessage:[0-9]+", origin) is None:
        basic.update({"enable_message_capture": False, "enable_auto_learning": False, "enable_realtime_learning": False})
    return config

def accepts_owner(event, config):
    origin = str(config.get("miobot_owner_umo") or "").strip()
    if re.fullmatch(r"[^:\s]+:FriendMessage:[0-9]+", origin) is None:
        return False
    channel, _, sender = origin.split(":", 2)
    try:
        return bool(str(event.unified_msg_origin) == origin and event.get_platform_name() == "aiocqhttp"
            and event.get_platform_id() == channel and event.is_private_chat()
            and str(event.get_sender_id()) == sender and not event.get_group_id()
            and type(event).__name__ != "CronMessageEvent"
            and event.get_extra("cron_job") is None and event.get_extra("cron_payload") is None)
    except Exception:
        return False
