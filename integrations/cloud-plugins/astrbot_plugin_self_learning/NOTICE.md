# Managed self-learning component

Source: NickMo / EterUltimate, NickCharlie/astrbot_plugin_self_learning 4.4.5,
captured read-only from the existing owner-managed deployment on 2026-11-04.
The original AGPL-3.0 license, authors and upstream repository are retained.
PROVENANCE.json records source hashes. MioBot revision: 4.4.5-miobot.1.
No existing chat database, learned persona, credentials or runtime state is
included in the bundle.

Managed behavior (`MIOBOT_MANAGED_CLOUD_PLUGINS=1`):

- `miobot_owner_umo` must be the exact QQ private session, for example
  `your-channel:FriendMessage:your-QQ-number`. Platform, channel, sender and
  private session must all agree; group, WebChat, cron and unresolved events
  are rejected by collection, request/response hooks and management commands.
- Message capture, automatic learning and realtime learning ship disabled.
  A missing or malformed owner also forces these off. After selecting an
  assistant and configuring the actual owner session, explicit settings under
  `Self_Learning_Basic` control capture/learning. The filter/refine/reinforce
  provider IDs in `Model_Configuration` must refer to configured native model
  providers; enabling learning can consume additional model calls.
- MioBot owns saved assistant personas. `Advanced_Settings.auto_apply_approved_persona`
  is forced false. The actual `Persona_Evolution_Settings` section has persona
  evolution, persona-manager updates and automatic persona application forced
  off. Learned material is not automatically written into MioBot's persona.
- Independent WebUI creation/start and automatic npm/pnpm dashboard builds are
  blocked in the managed host, including direct method calls. The native
  dependency-install endpoint refuses to install or replace the bundled Python
  environment. Host-authenticated plugin page registration is retained.
- Configured external data directories are ignored in managed mode; fresh
  learning data belongs to this instance's native plugin_data directory.

The pinned environment can import this plugin with its existing FastAPI,
uvicorn, itsdangerous, Jinja2 and database packages. Optional prometheus metrics
remain no-op if absent. No torch, sentence-transformers or additional Python
packages were installed for this integration.

Verification imports the real fixed AstrBot modules and tests scope/config,
command gating, standalone WebUI refusal and dependency/build guards using
isolated temporary data. It does not demonstrate trained style quality, paid
learning calls, live QQ capture or an end-to-end automatic learning session.
