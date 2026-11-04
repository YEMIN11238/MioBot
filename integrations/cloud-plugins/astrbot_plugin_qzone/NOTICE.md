# Qzone integration

Original plugin: Zhalslar/astrbot_plugin_qzone `v3.1.3`,
https://github.com/Zhalslar/astrbot_plugin_qzone . Original GPL-3.0 LICENSE,
source and bundled public rendering assets are retained.

MioBot revision `miobot.1` applies only with
`MIOBOT_MANAGED_CLOUD_PLUGINS=1`: commands and LLM tools require an actual
Aiocqhttp QQ event with administrator role, and use that event's bot. The
account-global plugin page routes are not registered and no first-platform
fallback is performed. It opens no extra HTTP listener. First-install defaults
leave publish/comment cron empty, random read probability zero, automatic likes
false, and campus-wall submissions disabled. Scheduled actions additionally
require `miobot_allow_scheduled_actions=true`; campus-wall commands additionally
require `miobot_enable_campus_wall=true`. They are optional configuration choices,
not enabled by importing or packaging the plugin. Credentials are obtained only
from the chosen QQ event's existing OneBot gateway at an explicit operation.

Optional picture rendering is lazy: without apilmoji/Pillow the existing sender
falls back to Plain text. Without optional json5, managed imports still work and
standard JSON/JSONP is parsed strictly; non-standard responses return the existing
parse-error payload. No eval or executable parsing is used. The original
requirements.txt is retained as the upstream optional-full-rendering dependency
list. Original standalone missing-dependency behavior is unchanged.

No QQ login state, cookies, runtime config, posts database, cached images or
conversation history is included. Successful local import and offline fixtures
do not validate live QQ login, publish delivery or rendered-card quality.
