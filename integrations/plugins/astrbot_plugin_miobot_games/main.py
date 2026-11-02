"""Fixed Minecraft facts, via MioBot's authenticated loopback bridge."""
import json
import os
from hashlib import sha256
from pathlib import Path
from urllib.parse import urlsplit

import aiohttp
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star, register
from astrbot.core.utils.astrbot_path import get_astrbot_skills_path


@register("astrbot_plugin_miobot_games", "MioBot", "Minecraft Java 1.21.8 离线物品与合成查询", "0.1.0")
class MioBotGames(Star):
    def __init__(self, context: Context):
        super().__init__(context)

    @filter.llm_tool(name="miobot_mc_guide")
    async def miobot_mc_guide(self, event: AstrMessageEvent) -> str:
        """读取已注册的 minecraft-guide Skill 全文；没有参数，仅能读取这一份内置指南，不能读取其他文件。"""
        try:
            skills_root = Path(get_astrbot_skills_path()).resolve()
            guide = (skills_root / "minecraft-guide" / "SKILL.md").resolve()
            if not guide.is_relative_to(skills_root) or not guide.is_file() or guide.stat().st_size > 32768:
                raise ValueError("Guide unavailable")
            raw = guide.read_bytes()
            return json.dumps({"ok": True, "skill": "minecraft-guide", "content": raw.decode("utf-8"), "source": {"kind": "native_skill_file", "path": "minecraft-guide/SKILL.md", "sha256": sha256(raw).hexdigest()}}, ensure_ascii=False)
        except Exception:
            return json.dumps({"ok": False, "error": {"code": "SKILL_UNAVAILABLE", "message": "Minecraft 内置指南未能读取，不能声称已经执行其中的要求。"}}, ensure_ascii=False)

    async def _lookup(self, event: AstrMessageEvent, name: str, args: dict) -> str:
        unavailable = {"ok": False, "version": "1.21.8", "error": {"code": "TOOL_UNAVAILABLE", "message": "游戏资料工具当前未连接，请稍后重试；没有执行游戏内操作。"}}
        base = os.environ.get("MIOBOT_TOOL_URL", "").rstrip("/")
        token = os.environ.get("MIOBOT_TOOL_TOKEN", "")
        try:
            parsed = urlsplit(base)
            if parsed.scheme not in ("http", "https") or parsed.hostname not in ("127.0.0.1", "localhost", "::1"):
                return json.dumps(unavailable, ensure_ascii=False)
            if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path or len(token) < 16:
                return json.dumps(unavailable, ensure_ascii=False)
            timeout = aiohttp.ClientTimeout(total=10, connect=3)
            async with aiohttp.ClientSession(timeout=timeout, trust_env=False) as client:
                async with client.post(
                    base + "/internal/game-tools",
                    json={"name": name, "args": args, "sessionId": event.session_id},
                    headers={"X-MioBot-Tool-Token": token},
                    allow_redirects=False,
                ) as response:
                    if response.status != 200:
                        return json.dumps(unavailable, ensure_ascii=False)
                    parts, size = [], 0
                    async for part in response.content.iter_chunked(16384):
                        size += len(part)
                        if size > 262144:
                            return json.dumps(unavailable, ensure_ascii=False)
                        parts.append(part)
                    payload = b"".join(parts)
                    result = json.loads(payload)
                    if not isinstance(result, dict) or not isinstance(result.get("ok"), bool):
                        return json.dumps(unavailable, ensure_ascii=False)
                    return json.dumps(result, ensure_ascii=False)
        except Exception:
            return json.dumps(unavailable, ensure_ascii=False)

    @filter.llm_tool(name="miobot_mc_item")
    async def miobot_mc_item(self, event: AstrMessageEvent, query: str) -> str:
        """查询 Minecraft Java 1.21.8 的静态物品或方块资料，不读取玩家背包。

        Args:
            query(string): 具体物品中文名或英文ID，例如钻石镐、oak_planks。
        """
        return await self._lookup(event, "item_lookup", {"query": query})

    @filter.llm_tool(name="miobot_mc_recipe")
    async def miobot_mc_recipe(self, event: AstrMessageEvent, query: str, quantity: int = 1) -> str:
        """查询 Minecraft Java 1.21.8 合成配方、直接材料总量和合成桌要求，不执行合成。

        Args:
            query(string): 具体成品中文名或英文ID，例如箱子、diamond_pickaxe。
            quantity(number): 期望获得的成品数量，1到4096的整数，默认1。
        """
        return await self._lookup(event, "recipe_lookup", {"query": query, "quantity": quantity})
