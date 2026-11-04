# RSSHub parser integration

MioBot reuses the **unchanged** `XMLFeedParser` and `EntryParsed`/`Enclosure`
modules from FlanChanXwO's `astrbot_plugin_rsshub` 2.1.4 at commit
`a047f46e47cb2a0f7a795f30b9f82ae027005846`. The audited source was obtained from
https://github.com/AstrBot-Elementary-School/astrbot_plugin_rsshub; the plugin
itself names https://github.com/FlanChanXwO/astrbot_plugin_rsshub as its repository.
Original source hashes and the AGPL-3.0 license are retained here.

`parse_feed.py` is a MioBot stdin/stdout adapter. It rejects DTDs/entities,
non-UTF-8/NUL input, non-feed roots and oversized/deep documents before calling
the real parser. It returns bounded plain text and provenance links; it never
opens URLs, interprets feed text as instructions or downloads attachments.

MioBot owns public-HTTPS fetching with DNS pinning and redirect validation,
assistant/source isolation, bounded snapshots and delivery-acknowledged dedup.
The original scheduler, database repositories, media rendering, Plugin Pages,
automatic discovery and outbound message senders are **not** installed. This is
a selective source integration rather than a complete unmodified RSSHub plugin.

The parser uses pinned `feedparser==6.0.14` and
`feedparser-sgmllib==2.1.0`, alongside the managed runtime's existing Pydantic and
defusedxml. Feedparser's own upstream licenses remain in its installed package.
No private feed URL, account, key, subscription or source database is included.

The application accepts public HTTPS feeds on port 443 without URL credentials
or credential-bearing query parameters. XML input is UTF-8 only, at most 2 MiB,
with at most 20,000 XML elements and 64 nesting levels. Each assistant may save
20 sources, and a run returns at most 30 items and 20,000 text characters. The
host owns when to run, summarize or deliver those items. Failed deliveries are
not marked sent. `commitDelivery({save:false})` plus `snapshotDelivery()` /
`restoreDelivery()` lets the host atomically save Web inbox delivery and dedup
with the workflow result. This is not a separate scheduler or sending service.
