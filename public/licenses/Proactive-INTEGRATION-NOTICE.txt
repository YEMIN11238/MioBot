# Proactive Chat integration for MioBot

MioBot reuses **DBJD-CR / Pancakes-Labs `astrbot_plugin_proactive_chat` v1.2.6**,
pinned to commit `635fc18eeb84e3c7b58661425359244552286835` at
https://github.com/Pancakes-Labs/astrbot_plugin_proactive_chat . The former
`DBJD-CR/astrbot_plugin_proactive_chat` URL now redirects to that repository.
The original AGPL-3.0 LICENSE and complete stable-release source are retained
under `upstream/`. No prior deployment's database, configuration or credentials
were copied. Archive URL and checksum are recorded in `UPSTREAM.json`.

## What runs

The managed plugin `astrbot_plugin_miobot_proactive` is a MioBot adapter, version
0.1.0. It imports and calls the **unchanged original**
`LlmMixin._build_dynamic_context_text()` from the pinned upstream source to build
runtime conversation context. The required upstream files and their LICENSE are
also included inside this deployable adapter directory. Its `/policy` endpoint
returns a bounded prompt and explicit eligibility result to the authenticated
MioBot service. The model and outbound channel are selected by MioBot, not by this
policy endpoint. No model tools are registered.

`policy.mjs` is MioBot integration code for explicit care on/off instructions and
strict instance/assistant/user/session/channel scope hashing. It does not parse
ordinary reminder requests as permission to send unsolicited care.

**The complete upstream plugin's private scheduler is not loaded or started.**
Its telemetry, independent WebUI, automatic startup triggers, TTS, notification
center and repeated-unanswered-message loop are not instantiated. MioBot's own
service remains the only scheduler and delivery owner. This avoids double sends,
ensures the same cloud service handles desktop and verified external channels,
and preserves the app's per-assistant controls.

## Deliberate behavior differences

- Strict identity scope requires an explicit instance, assistant, owner, native
  session and bound channel. Missing identifiers fail closed.
- Asia/Shanghai is explicit. Equal quiet-hour start/end means all-day quiet.
- An unanswered check-in blocks more check-ins until a real new user message;
  this does not escalate emotion or pressure the user to respond.
- Daily limits and idle intervals are validated before returning a prompt.
- At most six actual conversation messages, each at most 1200 characters, enter
  the prompt. Unprovided activities or progress must not be invented.
- Upstream's current-time placeholder is supplied independently from the caller's
  explicit clock, without globally monkey-patching its time helper.
- Voice and stickers are not introduced. No optional dependencies are added.

## Platform boundary

The original upstream v1.2.6 excludes WebChat from its eligible IM-instance list.
MioBot therefore does **not** claim that installing that unmodified plugin makes
the desktop receive background messages. The managed adapter supplies policy and
context for MioBot's inbox and for explicitly bound, verified external channels;
actual QQ delivery still requires MioBot's channel connection and successful
end-to-end testing. The adapter itself never sends a message.

## Verification

- `node --test tests/helpers/proactive-policy.test.mjs` tests explicit consent and
  scope isolation.
- `.runtime/astrbot-source/.venv/bin/python tests/helpers/proactive-plugin-smoke.py`
  imports the real pinned AstrBot and calls the real upstream context builder,
  validates policy refusals and confirms no private scheduler is created.
- `node tests/helpers/proactive-native-smoke.mjs` launches an isolated real native
  instance, calls the authenticated plugin HTTP endpoints, checks quiet hours and
  unanswered-turn refusal, and rejects unauthenticated access.

These tests issue no paid model request and send no external messages. They do
not prove that a particular QQ account is logged in or can receive a message.
