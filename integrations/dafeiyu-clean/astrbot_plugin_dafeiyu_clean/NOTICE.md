# 大肥鱼回复防串台 integration

MioBot reuses `astrbot_plugin_dafeiyu_clean` v0.1.0 by **zexuan604** from
[dafeiyu-config-pack](https://github.com/zexuanw958-svg/dafeiyu-config-pack).
This is not an original MioBot plugin. The local reference package is the video
tutorial package retained as `work/dafeiyu-pack-20261029`; the independent local
handoff names source revision `8c01b0361b8a4baff5be3d2bc67ed55108953086`.
The original `main.py`, `clean.py` and `metadata.yaml` are preserved unchanged in
`upstream/`, with their exact SHA-256 values in `PROVENANCE.json`.

## License evidence and distribution scope

The standalone plugin directory did not include a separate LICENSE or a license
field in its metadata. **The containing source configuration pack does declare
MIT for its own code, persona and settings** in its root README and LICENSE;
that original LICENSE, including `Copyright (c) 2026 zexuanw958-svg`, is retained
here and in the adapted plugin directory. Thus the evidence is not that the
whole source project has no stated license. MioBot distributes the adapted plugin with its source and preserves the original
MIT license, copyright notice and upstream attribution. The adapted plugin is
not represented as original MioBot code.

## Local compatibility changes

The adapted version is `v0.1.1-miobot`, keeping the original plugin name and hook
responsibilities. Its marker patterns are copied from the source plugin.

- Metadata now lists all 20 adapter IDs known to pinned AstrBot 4.29.3, including
  `webchat`. This is adapter-neutral text processing; it does not claim all real
  platform logins or deliveries have been tested.
- Every hook requires an explicit allowed profile plugin list containing
  `astrbot_plugin_dafeiyu_clean` or the explicit wildcard list `['*']`. Missing,
  empty or unrelated allow-lists leave content untouched.
- Request history cleaning changes only `role == 'assistant'` entries in the
  real `ProviderRequest.contexts` OpenAI dictionaries. It does not change user,
  system or tool history, the current user prompt, or the system prompt.
- Saved-context cleaning handles real `ContextWrapper.messages` / native
  `Message` objects, cleaning all assistant text entries. Native `TextPart` and
  OpenAI `{type:'text', text:...}` parts are supported; image, thinking and tool
  fields are not modified.
- Response cleaning only changes assistant `LLMResponse` text, preserving the
  original rich-message component order instead of collapsing all Plain parts
  through the deprecated completion-text setter. Tool responses are untouched.
- The pre-send hook acts only on model results, not ordinary command echoes or
  other non-model messages.
- Fenced and inline code examples are protected before applying the original
  marker-removal rules. Internal reminder/tool blocks are still removed as a
  whole even if their payload contains quoted code. This avoids corrupting
  ordinary technical explanations of DSML or `system_reminder` syntax.
- Log messages report a cleanup operation without logging the removed payload.

## Audited AstrBot contracts

Pinned AstrBot 4.29.3 sources were checked locally:

- `core/provider/entities.py`: `ProviderRequest.contexts` is an OpenAI-style
  `list[dict]`; `LLMResponse` has `role`, `result_chain`, and `completion_text`.
- `core/astr_agent_hooks.py`: `MainAgentHooks.on_agent_done` calls
  `OnLLMResponseEvent(event, response)` followed by
  `OnAgentDoneEvent(event, ContextWrapper, response)`.
- `core/agent/run_context.py` / `core/agent/message.py`:
  `ContextWrapper.messages` holds native typed messages with `TextPart` content.
- `core/star/star_handler.py` / `core/pipeline/context_utils.py`: the native hook
  dispatcher filters each hook using `event.plugins_name` before invocation.

`tests/helpers/clean-plugin-smoke.py` imports these actual native classes and
dispatches their hooks with synthetic local data. It uses no model API or saved
credentials. The tests cover marker cleanup, ordinary code preservation,
assistant-only history mutations, native saved text parts, rich response order,
profile isolation, and model-only pre-send behavior across synthetic adapter
events.

## Streaming boundary

These hooks clean completed model responses and persisted native context. They
cannot retract a raw delta already emitted to a streaming client. MioBot's BFF
must independently protect its stream/display boundary, and that behavior must
be tested through the actual HTTP/SSE route. Loading this plugin alone is not
evidence that live streaming text is protected.

No voice, sticker, QQ-signature, group-interruption or proactive-message plugin
is installed by this integration.
