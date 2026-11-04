# Managed QQ group forwarding component

Source: anka/astrbot_sowing_discord, installed metadata version v0.916,
captured read-only on 2026-11-04. The original MIT license and author remain.
PROVENANCE.json records source hashes. MioBot revision: v0.916-miobot.1.
Despite its original name, this plugin forwards selected QQ group messages;
it is not a Discord channel connector.

Managed changes (`MIOBOT_MANAGED_CLOUD_PLUGINS=1`):

- `banshi_group_list` and `banshi_target_list` ship empty. Both must explicitly
  contain numeric QQ group IDs; blanks, wildcards, booleans and malformed
  entries do not authorize anything. Empty targets never mean all groups.
- The event handler and forwarding routine reject unconfigured routes and
  events outside the explicitly allowed source/target groups. The original
  get-all-groups fallback is disabled in managed mode, including direct calls.
- The cache lives in this instance's native plugin_data directory. No previous
  cached messages or actual QQ group configuration ships in the bundle.

The component remains off until selected and configured in MioBot. Existing
native QQ access and permissions are needed for real forwarding. Type filters,
upstream evaluation and cooldown logic are retained. Offline tests verify empty
or invalid configuration performs no QQ API call, unrelated groups are ignored,
and only a configured source can enqueue its message. No real group was read or
sent a message, and no end-to-end live forwarding is claimed.
