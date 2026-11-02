# LivingMemory integration

MioBot bundles the existing LivingMemory AstrBot plugin, version 2.8.2, from
https://github.com/lxfight-s-Astrbot-Plugins/astrbot_plugin_livingmemory.
Author: lxfight. The vendored source and its original AGPL v3 license are retained
in `astrbot_plugin_livingmemory/`. The source is the locally audited snapshot in
`work/livingmemory-audit-20261029/source`, copied without runtime databases,
credentials, or user memory. The original memory engine is retained. One small
integration hardening in `core/utils/__init__.py` makes unresolved personas fail
closed when the managed runtime sets `MIOBOT_REQUIRE_MEMORY_PERSONA=1`; upstream
otherwise allows a `None` persona to omit the persona predicate. Without this
environment flag its original behavior is unchanged.
The audit snapshot omitted static resources. Its 11 original translation and
prompt files were restored from the upstream 2.8.2 release commit
`a1e9c20a8c5fab93d6143f51be26fb1bbf8143ec` (the original prompt manager Git blob
matches `2339a3f7f7f0206651f3483e31bc7bd0f5d61a95`).

MioBot stages this plugin into its own managed AstrBot data directory. The
integration selects user-scoped memory with persona filtering, disables passive
group capture and graph indexing, and exposes memory recall/write tools only to
assistants explicitly enabling long-term memory. Embedding and summary calls can
incur additional provider charges. A platform-specific user scope does not by
itself unify identities across different messaging platforms.
