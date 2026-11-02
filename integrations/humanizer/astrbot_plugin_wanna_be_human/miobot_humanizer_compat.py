"""MioBot integration policy for the pinned upstream Humanizer 4.1.9.

Upstream standalone behavior is unchanged unless MIOBOT_MANAGED_PERSONALITY=1.
Managed state is strictly scoped by resolved persona, sender and native session.
"""
from __future__ import annotations

import hashlib
import json
import os

SCOPE_EXTRA = "_miobot_humanizer_scope_v1"
FORBIDDEN_FEATURES = {
    "style": {
        "auto_build_default": False,
        "enable_retrieval": False,
        "create_kb": False,
        "auto_extract_on_upload": False,
        "rebuild_style": False,
        "qc_enable": False,
    },
    "time": {
        "enable_life": False,
        "enable_llm_timeline": False,
        "mood_enabled": False,
        "awareness_mode": "custom",
    },
    "emotion": {
        "emotion_mode": "custom",
        "emotion_cold_drift": 0.0,
        "emotion_intensity_cap": 0.35,
        "emotion_reunion_inject": False,
    },
    "proactive": {
        "enable_proactive": False,
        "proactive_preset": "custom",
        "proactive_followup_enable": False,
        "proactive_pout_on_unanswered": False,
    },
    "typing": {
        "enable": False,
        "split_enable": False,
        "debounce_enable": False,
        "enable_adaptive_debounce": False,
        "enable_typing_detection": False,
        "enable_recall_filter": False,
        "send_discipline_enabled": False,
    },
}


def managed() -> bool:
    return os.environ.get("MIOBOT_MANAGED_PERSONALITY") == "1"


def config_value(group, key):
    if managed() and key in FORBIDDEN_FEATURES.get(group, {}):
        return True, FORBIDDEN_FEATURES[group][key]
    return False, None


def enforce_config(config):
    if not managed():
        return
    for group, fields in FORBIDDEN_FEATURES.items():
        existing = config.get(group)
        if not isinstance(existing, dict):
            existing = {}
            config[group] = existing
        existing.update(fields)


def state_key(event) -> str:
    if not managed():
        return str(getattr(event, "unified_msg_origin", "") or "")
    try:
        value = event.get_extra(SCOPE_EXTRA)
        return value if isinstance(value, str) and value.startswith("miobot:v1:") else ""
    except Exception:
        return ""


async def prepare_scope(context, event, request=None) -> bool:
    if not managed():
        return True
    if request is None and state_key(event):
        return True
    # Do not reuse a scope from an earlier provider step without resolving its
    # effective persona again: changing persona must never retain the old key.
    try:
        event.set_extra(SCOPE_EXTRA, "")
        origin = str(getattr(event, "unified_msg_origin", "") or "")
        sender = str(event.get_sender_id() or "")
        platform = str(event.get_platform_name() or "")
        native_session = str(getattr(event, "session_id", "") or "")
        if not all((origin, sender, platform, native_session)) or platform == "cron":
            return False
        conversation = getattr(request, "conversation", None) if request is not None else None
        if conversation is None:
            cid = await context.conversation_manager.get_curr_conversation_id(origin)
            if cid:
                conversation = await context.conversation_manager.get_conversation(origin, cid)
        selected, persona, _, special_default = await context.persona_manager.resolve_selected_persona(
            umo=origin,
            conversation_persona_id=getattr(conversation, "persona_id", None),
            platform_name=platform,
            provider_settings={},
        )
        if (
            not isinstance(selected, str)
            or selected in {"", "default", "[%None]", "_chatui_default_"}
            or not isinstance(persona, dict)
            or persona.get("name") != selected
            or special_default
        ):
            return False
        cid = str(getattr(conversation, "cid", "") or "")
        payload = json.dumps([selected, sender, platform, origin, native_session, cid], ensure_ascii=False, separators=(",", ":"))
        digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()
        event.set_extra(SCOPE_EXTRA, "miobot:v1:" + digest)
        return True
    except Exception:
        # Losing persona/user/session information disables enhancement for the
        # event; it never falls back to a global user or a different persona.
        try:
            event.set_extra(SCOPE_EXTRA, "")
        except Exception:
            pass
        return False
