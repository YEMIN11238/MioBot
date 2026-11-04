from __future__ import annotations

import asyncio
import os
from pathlib import Path

from ..config import PluginConfig
from ..model import Post
from .parser_card_data import Author, ParseResult, Platform
from .post_adapter import QzonePostCardAdapter
from .resource_fetcher import ResourceFetcher


class BuiltinQzoneCardRenderer:
    def __init__(self, config: PluginConfig):
        self.cfg = config
        try:
            from .parser_card_renderer import Renderer as ParserCardRenderer
        except ModuleNotFoundError as exc:
            if os.environ.get("MIOBOT_MANAGED_CLOUD_PLUGINS") != "1" or exc.name not in {"apilmoji", "apilmoji.core", "PIL"}:
                raise
            self.renderer = None
            return
        self.fetcher = ResourceFetcher(config)
        self.adapter = QzonePostCardAdapter(self.fetcher)
        self.renderer = ParserCardRenderer(config)
        self._resources_loaded = False

    async def _ensure_resources_loaded(self) -> None:
        if self._resources_loaded:
            return
        await asyncio.to_thread(type(self.renderer).load_resources)
        self._resources_loaded = True

    async def render_post(self, post: Post) -> Path | None:
        if self.renderer is None:
            return None
        await self._ensure_resources_loaded()
        result = await self.adapter.to_parse_result(post)
        return await self.renderer.render_card(result)

    async def render_text(self, text: str) -> Path | None:
        if self.renderer is None:
            return None
        if not text.strip():
            return None

        await self._ensure_resources_loaded()
        result = ParseResult(
            platform=Platform(name="qzone", display_name="QQ空间"),
            author=Author(name="系统消息"),
            text=text,
        )
        return await self.renderer.render_card(result)
