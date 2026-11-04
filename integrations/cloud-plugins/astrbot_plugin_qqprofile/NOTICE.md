# QQ profile integration

Original plugin: Zhalslar/astrbot_plugin_qqprofile, cloud snapshot version
`v1.1.6-owner-avatar.2`, https://github.com/Zhalslar/astrbot_plugin_qqprofile .
Original AGPL-3.0 LICENSE is retained. The owner-avatar.2 snapshot already contains
the earlier cross-container avatar repair (current attached/quoted image bytes
sent as OneBot base64; gateway acceptance is not display verification).

MioBot revision `miobot.1` adds guards only when
`MIOBOT_MANAGED_CLOUD_PLUGINS=1`: source must be an actual Aiocqhttp QQ event with
its own bot and administrator role. WebChat cannot use a different logged-in QQ
account. Native persona listing/switching is refused in managed mode so those
operations continue through MioBot's assistant management. Nickname/persona
automatic synchronization is false on first install. No account, existing avatar,
private key, runtime configuration or conversation is included.

Only the selected assistant receives this optional plugin. Source presence is
not QQ login, gateway authorization or an actual QQ send/display test.
