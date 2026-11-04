# MioBot singing optional component

Original author: zexuan604, within zexuanw958-svg/dafeiyu-config-pack.
The cloud deployment version was `v0.2.1`. MIT license and source fingerprints
are retained. This integration is `v0.2.1-miobot.1`.

MioBot stages this optional plugin only when enabled. Managed mode requires the
explicit owner QQ private session and a direct point-song request. WebChat,
other senders, quoted/forwarded requests and scheduler events cannot authorize
its direct platform send. Managed Doubao mode uses this component's explicit
APP ID / Access Token only; it does not borrow unrelated TTS provider credentials.
Missing configuration and generation failure produce truthful failure messages.

The default Doubao route imports only aiohttp, the standard library and the
retained melody definitions. The original `sing_server` source remains as
reference for an optional external SoulX service. Its nested requirements are
not MioBot runtime requirements and must not be installed automatically. The
private `sing_server/voice` audio and metadata directory is intentionally omitted.
No model weights, reference audio, credentials or generated output are shipped.

Native import and isolated send-path tests do not prove paid synthesis, musical
quality, actual QQ delivery or WebChat playback. The original README's standalone
server setup describes additional software outside this integration.
