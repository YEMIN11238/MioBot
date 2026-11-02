# Humanizer integration for MioBot

MioBot vendors **SIiOC/astrbot-plugin-humanizer**, upstream plugin name
`astrbot_plugin_wanna_be_human`, version **4.1.9**, at the exact commit
[`38e732119b309164636671cb715c7a43575b68a7`](https://github.com/SIiOC/astrbot-plugin-humanizer/commit/38e732119b309164636671cb715c7a43575b68a7).
The original author is SIiOC and the original AGPL-3.0 license is retained in
`astrbot_plugin_wanna_be_human/LICENSE`. This is a modified integration, not an
unmodified upstream distribution. The metadata retains upstream version 4.1.9;
the integration revision is **miobot.1**.

The source archive URL, original main-file checksum and provenance are in
`UPSTREAM.json`. Source was copied without runtime databases, user configuration,
credentials or caches. Upstream source, its tests, console source, original seed
corpus and attribution are retained. The upstream README attributes its rule
origins to [Humanizer-zh](https://github.com/op7418/Humanizer-zh) and
[stop-slop](https://github.com/hardikpandya/stop-slop).

## Managed changes

Changes are activated only when MioBot sets `MIOBOT_MANAGED_PERSONALITY=1`:

- `miobot_humanizer_compat.py` resolves the effective persona through AstrBot's
  native persona manager. Persistent emotion, time, continuity and observed
  language-style state use SHA-256 keys derived from persona, sender, platform,
  physical UMO/native session and native conversation. A missing or unresolved
  component skips the enhancement; it never falls back to a global profile.
  Original routing identifiers are retained for native configuration lookups.
- `main.py` uses these scoped keys, ensures direct WebChat requests trigger the
  existing trackers once per event/scope, and leaves timestamp persistence active.
  It disables its proactive scheduler, debounce/typing/split delivery hooks,
  automatic style extraction, auxiliary LLM calls, style knowledge-base creation
  and retrieval, and fictional daily-life generation. MioBot manages delivery and
  opt-in care separately. No LLM tools or outbound capabilities are added.
- `MIOBOT_DEFAULTS.json` is a first-install configuration patch for the upstream
  schema. Core enhancement switches remain configurable; out-of-scope background
  model and delivery features are additionally blocked by the managed policy.
  No optional package is required; calendar features remain disabled and
  upstream's optional `lunar_python` requirement is commented in requirements.
- The default style `styles/MioBot自然对话.json` is authored for MioBot and contains
  expression references without real-life or autobiographical claims. The
  original seed style is retained but is not the managed default.
- Bot emotional expression is limited to mild positive continuity: negative
  cold-conversation drift is disabled, intensity is capped at 0.35, unanswered
  message sulking/reunion pressure is disabled, and negative stored states do not
  inject emotional directives. This is not a psychological assessment of users.
- The upstream `builtin-qc-disclaimer` rule is disabled and excluded. The Chinese
  knowledge-disclaimer removal stage is skipped in managed mode. The request
  keeps truthful AI identity, knowledge limits and tool-result boundaries. Code
  fences bypass response cleanup and remain unchanged.
- Current time can be included on a first managed request without inventing an
  earlier conversation. Native datetime injection is still respected to avoid
  duplicate wall-clock statements. Scope resolution failures leave base chatting
  available without enhancement.

Outside the managed environment the original host behavior is retained. These
patches do not add voice, stickers, live device awareness, game control or any
claim that the bot is human. Existing MioBot LivingMemory remains the sole
configured long-term memory plugin for this integration; Humanizer does not add
a second memory engine.

## Verification boundary

`tests/helpers/humanizer-plugin-smoke.py` imports the actual pinned AstrBot and
actual vendored plugin, executes request and response hooks, verifies
persona/user/session separation and fail-closed behavior, checks truthful AI
disclosure and code preservation, and refuses auxiliary LLM/knowledge-base calls.
It uses a temporary root and a fake local context; it sends zero paid model
requests. Full native HTTP/SSE behavior is verified separately by MioBot's
integration test. Hook registration alone does not prove response cleanup reaches
the final chat renderer.
