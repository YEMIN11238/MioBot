# MioBot Seed Audio optional component

Original author: dafeiyu-pack, within zexuanw958-svg/dafeiyu-config-pack.
The owner's existing cloud deployment version was `v0.2.3-owner-control`.
MIT license and copyright are retained in LICENSE; source fingerprints are in
PROVENANCE.json. This is the modified `v0.2.3-owner-control-miobot.1` integration.

MioBot installs this optional plugin only when the owner enables it. With
`MIOBOT_MANAGED_CLOUD_PLUGINS=1`, it handles only the explicitly configured native
QQ owner session and does not intercept MioBot WebChat audio delivery. The
managed schema adds separately stored APP ID / Access Token, a voice description
and an automatic voice probability (default 0.08). Empty credentials do not
borrow another provider's configuration. The saved reply mode defaults to text;
explicit direct commands and the existing stop-wins control policy are retained.
The old real-account documentation example was replaced with a placeholder.

No cloud credentials, login state, chat history, private audio or generated media
are included. Loading and offline event checks do not validate a paid provider,
voice quality, fees or actual QQ audio playback. The original README describes
the standalone plugin; its native provider setup is not required by MioBot's
managed explicit-credential path.
