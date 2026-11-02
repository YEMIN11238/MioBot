# MioBot media integration

This MioBot-authored plugin uses AstrBot's native model-tool registration and the
application's authenticated, loopback-only assistant bridge. It does not copy QQ
voice credentials, user stickers, a voice model, or upstream account state.

`miobot_voice_reply(text)` and `miobot_send_sticker(sticker_id)` return media
metadata. The application must validate the originating native session, current
assistant, owner, enabled capability and explicit current user intent. It adds
authenticated attachments to the current conversation; it must not describe
these as successful external QQ deliveries.

Speech follows the configurable Speech API protocol also used by AstrBot's
`openai_tts_api` adapter: `POST /audio/speech` with `model`, `voice`, `input` and
`response_format: wav`. API credentials are separately configured and are never
borrowed from a chat connection. There is no hard-coded default model.

Official contract checked on 2026-11-02:
https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create

The current official page announces retirement of its legacy Speech models on
2027-01-06; configurable compatible services have their own model availability.
This integration does not claim current paid access or support for every service.

No paid service is called by its tests. Local tests use a loopback fake Speech
endpoint producing a real PCM WAV and an isolated, explicitly uploaded PNG.
Existing media remains readable only by its owner/assistant even if generation
is later switched off. No automatic sticker collection or external sending is
enabled.

License: AGPL-3.0-only, as part of MioBot. Source is provided alongside the project.
