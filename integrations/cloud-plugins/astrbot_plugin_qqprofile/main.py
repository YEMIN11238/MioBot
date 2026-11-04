import asyncio
import os
import base64

import astrbot.api.message_components as Comp
from astrbot.api import logger
from astrbot.api.event import filter
from astrbot.api.star import Context, Star
from astrbot.core.config.astrbot_config import AstrBotConfig
from astrbot.core.platform import AstrMessageEvent
from astrbot.core.platform.sources.aiocqhttp.aiocqhttp_message_event import (
    AiocqhttpMessageEvent,
)
from astrbot.core.star.filter.permission import PermissionType
from astrbot.core.star.star_tools import StarTools

from .status import status_mapping
from .utils import get_nickname


def _managed_allowed(event) -> bool:
    return (os.environ.get("MIOBOT_MANAGED_CLOUD_PLUGINS") != "1" or
            (isinstance(event, AiocqhttpMessageEvent) and getattr(event, "bot", None) is not None and event.is_admin()))


class QQProfilePlugin(Star):
    def __init__(self, context: Context, config: AstrBotConfig):
        super().__init__(context)
        self.conf = config
        self.curr_nickname = None
        self.avatar_dir = StarTools.get_data_dir("astrbot_plugin_qqprofile") / "avatar"
        self.avatar_dir.mkdir(parents=True, exist_ok=True)

    async def get_curr_persona_id(self, event: AstrMessageEvent) -> str | None:
        """获取当前会话的人格ID"""
        if not _managed_allowed(event):
            return
        umo = event.unified_msg_origin
        cid = await self.context.conversation_manager.get_curr_conversation_id(umo)
        if not cid:
            return
        conversation = await self.context.conversation_manager.get_conversation(
            unified_msg_origin=umo,
            conversation_id=cid,
            create_if_not_exists=True,
        )
        if (
            conversation
            and conversation.persona_id
            and conversation.persona_id != "[%None]"
        ):
            return conversation.persona_id

        # 兜底
        if persona_v3 := self.context.persona_manager.selected_default_persona_v3:
            persona_id = persona_v3.get("name")

            if persona_id and persona_id != "[%None]":
                return persona_id

    @filter.permission_type(PermissionType.ADMIN)
    @filter.llm_tool(name="qqprofile_set_avatar")
    async def set_avatar(self, event: AiocqhttpMessageEvent) -> str:
        """Set avatar using an image ATTACHED TO or QUOTED IN the CURRENT message.

        Earlier conversation images are not available to this tool. Report the
        returned outcome accurately: missing image means NO change was made;
        gateway acceptance alone does not verify the displayed QQ avatar.
        """
        if not _managed_allowed(event):
            return "未执行：请由管理员在对应 QQ 会话中操作。"
        return await self._set_avatar_from_event(event)

    @filter.permission_type(PermissionType.ADMIN)
    @filter.command("设置头像")
    async def set_avatar_command(self, event: AiocqhttpMessageEvent):
        if not _managed_allowed(event):
            yield event.plain_result("未执行：请由管理员在对应 QQ 会话中操作。")
            return
        result = await self._set_avatar_from_event(event)
        yield event.plain_result(result)

    async def _set_avatar_from_event(self, event: AiocqhttpMessageEvent) -> str:
        if not _managed_allowed(event):
            return "未执行：请由管理员在对应 QQ 会话中操作。"
        if not event.is_admin():
            return "未执行换头像：仅管理员可以修改机器人头像。"
        chain = event.get_messages()
        image = next((seg for seg in chain if isinstance(seg, Comp.Image)), None)
        if image is None:
            image = next(
                (
                    reply_seg
                    for seg in chain
                    if isinstance(seg, Comp.Reply) and seg.chain
                    for reply_seg in seg.chain
                    if isinstance(reply_seg, Comp.Image)
                ),
                None,
            )
        if image is None:
            logger.info("qqprofile.avatar_update outcome=missing_image")
            return (
                "未执行换头像：当前消息没有附图，也没有引用图片。"
                "我无法从之前的聊天里直接取图。请回复要用的那张图片，发送 /设置头像。"
            )

        # The QQ gateway may run in a different container and cannot read
        # AstrBot's local media paths. OneBot accepts inline image bytes.
        try:
            image_base64 = await image.convert_to_base64()
            image_bytes = base64.b64decode(image_base64, validate=True)
        except Exception as e:
            logger.warning(f"qqprofile.avatar_update outcome=read_failed error={type(e).__name__}")
            return "未执行换头像：这张图片读取失败。请重新附图或引用图片再试。"
        try:
            await event.bot.set_qq_avatar(file=f"base64://{image_base64}")
        except Exception as e:
            logger.warning(f"qqprofile.avatar_update outcome=gateway_failed error={type(e).__name__}")
            return "换头像失败：QQ 网关没有确认更新成功，头像未确认更换。"
        logger.info(f"qqprofile.avatar_update outcome=gateway_accepted bytes={len(image_bytes)}")
        try:
            if persona_id := await self.get_curr_persona_id(event):
                save_path = self.avatar_dir / f"{persona_id}.jpg"
                await asyncio.to_thread(save_path.write_bytes, image_bytes)
                logger.debug(f"头像已保存到：{str(save_path)}")
        except Exception as e:
            logger.warning(f"qqprofile.avatar_cache outcome=failed error={type(e).__name__}")
        return "QQ 网关已接受这张图片的头像更新请求；我还不能确认 QQ 显示的头像已经更新。"

    @filter.permission_type(PermissionType.ADMIN)
    @filter.llm_tool(name="qqprofile_set_signature")
    @filter.command("设置签名")
    async def set_longnick(
        self, event: AiocqhttpMessageEvent, longnick: str | None = None
    ):
        """Set the bot's QQ signature.

        Args:
            longnick(string): The new signature text.
        """
        if not _managed_allowed(event):
            yield event.plain_result("未执行：请由管理员在对应 QQ 会话中操作。")
            return
        if not event.is_admin():
            yield event.plain_result("仅管理员可以修改机器人签名")
            return
        if not longnick:
            yield event.plain_result("没提供新签名呢")
            return
        await event.bot.set_self_longnick(longNick=longnick)
        yield event.plain_result(f"我签名已更新：{longnick}")

    @filter.permission_type(PermissionType.ADMIN)
    @filter.llm_tool(name="qqprofile_set_status")
    @filter.command("设置状态")
    async def set_status(
        self, event: AiocqhttpMessageEvent, status_name: str | None = None
    ):
        """Set the bot's QQ online status.

        Pass one exact supported name: 在线, Q我吧, 离开, 忙碌, 请勿打扰, 隐身,
        听歌中, 春日限定, 一起元梦, 求星搭子, 被掏空, 今日天气, 我crush了, 爱你,
        恋爱中, 好运锦鲤, 水逆退散, 嗨到飞起, 元气满满, 宝宝认证, 一言难尽, 难得糊涂,
        emo中, 我太难了, 我想开了, 我没事, 想静静, 悠哉哉, 去旅行, 信号弱, 出去浪,
        肝作业, 学习中, 搬砖中, 摸鱼中, 无聊中, timi中, 睡觉中, 熬夜中, 追剧中,
        有亿点冷, 一月你好, 我的电量. Map natural expressions to the closest exact
        value, for example, "busy" to 忙碌.

        Args:
            status_name(string): An exact supported status name from the list above.
        """
        if not _managed_allowed(event):
            yield event.plain_result("未执行：请由管理员在对应 QQ 会话中操作。")
            return
        if not event.is_admin():
            yield event.plain_result("仅管理员可以修改机器人状态")
            return
        if not status_name:
            yield event.plain_result("没提供新状态呢")
            return
        params = status_mapping.get(status_name, None)
        if not params:
            yield event.plain_result(f"状态【{status_name}】暂未支持")
            return
        await event.bot.set_online_status(
            status=params[0], ext_status=params[1], battery_status=0
        )
        yield event.plain_result(f"我状态已更新为【{status_name}】")

    @filter.permission_type(PermissionType.ADMIN)
    @filter.llm_tool(name="qqprofile_set_nickname")
    @filter.command("设置昵称")
    async def set_nickname(
        self, event: AiocqhttpMessageEvent, nickname: str | None = None
    ):
        """Set the bot's QQ nickname.

        Args:
            nickname(string): The new nickname; defaults to the current persona name.
        """
        if not _managed_allowed(event):
            yield event.plain_result("未执行：请由管理员在对应 QQ 会话中操作。")
            return
        if not event.is_admin():
            yield event.plain_result("仅管理员可以修改机器人昵称")
            return
        nickname = nickname or await self.get_curr_persona_id(event)
        if not nickname:
            yield event.plain_result("未输入新昵称")
            return
        await event.bot.set_qq_profile(nickname=nickname)
        yield event.plain_result(f"我昵称已改为【{nickname}】")

    async def sync_nickname_and_avatar(
        self, event: AiocqhttpMessageEvent, persona_id: str
    ):
        """在请求 LLM 前同步bot昵称与人格名"""
        if not _managed_allowed(event):
            return

        if not self.curr_nickname:
            if new_nickname := await get_nickname(event):
                self.curr_nickname = new_nickname

        if self.curr_nickname != persona_id:
            self.curr_nickname = persona_id

            await event.bot.set_qq_profile(nickname=persona_id)
            logger.debug(f"已同步bot的昵称为：{persona_id}")
            avatar_path = self.avatar_dir / f"{persona_id}.jpg"
            if avatar_path.exists():
                image_base64 = await Comp.Image.fromFileSystem(
                    str(avatar_path)
                ).convert_to_base64()
                await event.bot.set_qq_avatar(file=f"base64://{image_base64}")
                logger.debug(f"已同步bot的头像为：{str(avatar_path)}")

    @filter.permission_type(filter.PermissionType.ADMIN)
    @filter.llm_tool(name="qqprofile_switch_persona")
    @filter.command("切换人格")
    async def change_persona(
        self, event: AiocqhttpMessageEvent, persona_id: str | None = None
    ):
        """Switch the current conversation to a persona.

        Args:
            persona_id(string): The name of the persona to switch to.
        """
        if os.environ.get("MIOBOT_MANAGED_CLOUD_PLUGINS") == "1":
            yield event.plain_result("请在 MioBot 中管理或切换这位助手的人设。")
            return
        if not event.is_admin():
            yield event.plain_result("仅管理员可以切换人格")
            return

        # 确定目标人格ID
        if persona_id:
            target_persona = next(
                (
                    p
                    for p in self.context.provider_manager.personas
                    if p["name"] == persona_id
                ),
                None,
            )
            if not target_persona:
                yield event.plain_result(f"【{persona_id}】人格不存在")
                return
            target_persona_id = target_persona["name"]
        else:
            target_persona_id = await self.get_curr_persona_id(event)
            if not target_persona_id:
                return

        # 切换人格
        await self.context.conversation_manager.update_conversation_persona_id(
            event.unified_msg_origin, target_persona_id
        )
        yield event.plain_result(f"已切换人格【{target_persona_id}】")

        # 同步昵称和头像（如果配置允许）
        if self.conf["sync_name"]:
            await self.sync_nickname_and_avatar(event, target_persona_id)

        event.stop_event()

    @filter.permission_type(filter.PermissionType.ADMIN)
    @filter.llm_tool(name="qqprofile_list_personas")
    @filter.command("人格列表", alias={"查看人格列表"})
    async def list_persona(self, event: AiocqhttpMessageEvent):
        """List available personas and their prompts."""
        if os.environ.get("MIOBOT_MANAGED_CLOUD_PLUGINS") == "1":
            yield event.plain_result("请在 MioBot 中管理或切换这位助手的人设。")
            return
        if not event.is_admin():
            yield event.plain_result("仅管理员可以查看人格列表")
            return
        msg = ""
        for persona in self.context.provider_manager.personas:
            msg += f"\n\n【{persona['name']}】:\n{persona['prompt']}"
        yield event.plain_result(msg.strip())
        return
