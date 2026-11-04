# Bilibili basic stickers for MioBot

Source: AIPM's `astrbot_plugin_bilibili_basic_stickers` v0.1.0, copied read-only
from the owner's existing deployment on 2026-11-04. `CLOUD_SOURCE.json` records
original source hashes. This distribution includes no credentials, QQ login
state, personal images, or copied library. The code is MIT licensed; the license
does not relicense the original Bilibili image artwork.

Only eleven fixed public small-TV images in catalog.json are supported.
Collection requires the real owner to make an explicit direct QQ-private-chat
request. `owner_qq` and `owner_umo` must be separately configured and agree with
the actual platform/channel/sender. They ship empty. Paid emote packs, UP-specific
packs, arbitrary URLs, Cookie login and Bilibili crawling are not implemented.

MioBot changes: remove the private-account example from the schema, retain
empty owner defaults, add this provenance/license, and register the source as
an optional bundled component. Runtime collector behavior is unchanged. The
native meme_manager must be enabled and assigned to the same assistant first;
its native private library is not MioBot's desktop/mobile private media store.

Native tools: collect_bilibili_basic_stickers and send_bilibili_basic_sticker.
There is no background download on import or activation; a real, authorized
collection request performs the bounded download. A successful configuration or
import is not proof of a real QQ delivery.
