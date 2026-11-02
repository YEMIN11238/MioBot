# MioBot managed proactive adapter

This adapter is part of MioBot and distributed under AGPL-3.0. It reuses the
original DBJD-CR / Pancakes-Labs Proactive Chat v1.2.6 dynamic-context builder at
commit `635fc18eeb84e3c7b58661425359244552286835`.

The copied `upstream/core/llm_adapter.py`, `upstream/core/proactive_event.py`, and
`upstream/utils/time_utils.py` are unchanged from that commit. Their original
AGPL license is retained under `upstream/LICENSE` and `LICENSE`. Complete source,
archive checksum, scope and integration differences are preserved in the parent
MioBot source directory `integrations/proactive/`.

The adapter registers only authenticated policy/status endpoints. It creates no
private scheduler, telemetry, WebUI, model request, voice/sticker behavior or
outbound message. MioBot's service controls timing, target ownership and delivery.
