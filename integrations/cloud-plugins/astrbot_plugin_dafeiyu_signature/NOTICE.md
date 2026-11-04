# Signature integration

Original plugin by zexuan604, `v0.1.3`, from the dafeiyu configuration
pack https://github.com/zexuanw958-svg/dafeiyu-config-pack . The original pack's
MIT LICENSE (copyright 2026 zexuanw958-svg) is retained. This is not an unmodified
upstream distribution. File checksums of the owner cloud source snapshot are
recorded in PROVENANCE.json.

MioBot revision `miobot.1` applies only with
`MIOBOT_MANAGED_CLOUD_PLUGINS=1`: QQ source event and event.bot are mandatory;
owner_session/admin checks remain, and it never falls back to the first QQ client
when called from WebChat. Automatic mood-triggered signature hints default to
false, owner session is empty until configured. Existing daily limits remain.
Gateway exceptions do not create a successful history entry. No old signature
history, owner identifier, runtime configuration or credential is included.
