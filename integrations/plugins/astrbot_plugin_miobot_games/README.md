# MioBot Minecraft facts bridge

This bundled AstrBot plugin exposes `miobot_mc_item`, `miobot_mc_recipe` and the parameter-free `miobot_mc_guide` to assistants that explicitly enable the Minecraft capability. The guide tool reads only the registered `minecraft-guide/SKILL.md` under the native Skills root; it accepts no file path. It does not connect to Minecraft, inspect inventory, query a server, or execute game commands.

The managed runtime supplies `MIOBOT_TOOL_URL` (loopback origin only) and `MIOBOT_TOOL_TOKEN`. The plugin sends a fixed tool name, validated query arguments and AstrBot's existing `event.session_id` to `/internal/game-tools`. The user/session identifier is not a model argument. The bridge checks the token and the assistant's capability. Tokens are never returned to the model.

Uses AstrBot's existing `aiohttp` dependency. No additional package installation is required. Dataset attribution and provenance are in `integrations/game-data` in the MioBot distribution.
