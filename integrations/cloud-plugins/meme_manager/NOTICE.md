# MioBot managed meme manager

Source: anka/astrbot_plugin_meme_manager, installed cloud version
`v5.2.10-owner-stickers.1`, captured read-only on 2026-11-04. The original
MIT license and author are retained. `CLOUD_SOURCE.json` records original file
hashes; it contains source provenance, not server credentials or a library.
The managed revision is `v5.2.10-owner-stickers.1-miobot.1`.

No personal images, runtime databases, user configuration, tokens, or cloud
image-host configuration are bundled. Upstream screenshots, test fixtures and
image_host/config*.json were excluded from this distribution.

Changes apply to the managed host where noted:

- When `MIOBOT_MANAGED_CLOUD_PLUGINS=1`, automatic collection is fail closed:
  `auto_collect.owner_qq` and `owner_umo` must explicitly identify the same real
  QQ private session, and only that sender/platform/channel is allowed. Group,
  WebChat, cron and unresolved events are rejected. Platform sticker markers
  are mandatory even if `only_platform_stickers` is unchecked; unmarked photos
  and screenshots do not reach the classifier. Enabled collection still needs
  a configured vision provider and a selected private pack. Both owner fields
  ship empty and `auto_collect.enabled` ships false.
- Managed prompt maintenance never rewrites another persona's stored prompt.
  Per-request native hooks continue to use the host-selected plugin profile.
- Credentials in the native schema carry `_secret: true` so MioBot can store
  them separately and avoid returning them in its configuration API.
- Optional Cloudflare R2 imports `minio` only when explicitly configured. Local
  libraries do not require minio, tqdm, or cloud storage; missing minio produces
  an explicit configuration error. Optional dependencies are documented in
  requirements rather than triggering automatic installation at plugin import.

The original authenticated `Context.register_web_api` integration is retained;
no independent WebUI listener is added. The native library lives in this
instance's `data/plugin_data/meme_manager`, separate from MioBot's existing
private media assets. Native QQ image delivery remains plugin behavior; this
integration does not make MioBot's desktop/mobile chat renderer consume native
WebChat image events or automatically share these two libraries.

Tests use the pinned real AstrBot imports and isolated temporary data, including
owner/scope enforcement and the ordinary-image rejection path; no paid vision
model, live QQ account, external download, or cloud image host is used.
