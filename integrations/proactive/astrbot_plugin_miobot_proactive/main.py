"""Managed adapter around the attributed proactive context core, no timer."""
from __future__ import annotations
import os

from astrbot.api.star import Context, Star
from quart import request

from .managed_policy import build_policy, SOURCE

NAME = "astrbot_plugin_miobot_proactive"


class MioBotProactive(Star):
    def __init__(self, context: Context):
        super().__init__(context)
        self.context.register_web_api(f"/{NAME}/status", self.status, ["GET"], "MioBot proactive policy status")
        self.context.register_web_api(f"/{NAME}/policy", self.policy, ["POST"], "MioBot proactive policy and context")

    async def status(self):
        return {"status": "ok", "data": {"ready": os.environ.get("MIOBOT_MANAGED_PROACTIVE") == "1", "scheduler": "miobot-service-only", "source": SOURCE, "voice": False, "stickers": False, "telemetry": False}}

    async def policy(self):
        if os.environ.get("MIOBOT_MANAGED_PROACTIVE") != "1":
            return {"status": "error", "message": "主动关心策略尚未由 MioBot 服务启用"}
        try:
            payload = await request.get_json(silent=True)
            return {"status": "ok", "data": build_policy(payload)}
        except ValueError as exc:
            return {"status": "error", "message": str(exc)}
