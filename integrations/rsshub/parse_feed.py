"""Bounded stdin/stdout adapter around the unchanged attributed RSSHub parser.

No URL is opened here. The host fetches approved public feeds and sends bytes.
"""
from __future__ import annotations
import base64
import json
import sys
from pathlib import Path
from html import unescape
from html.parser import HTMLParser
import re
import types

MAX_XML = 2 * 1024 * 1024


class PlainText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style", "iframe", "object"}:
            self.skip += 1

    def handle_endtag(self, tag):
        if tag in {"script", "style", "iframe", "object"} and self.skip:
            self.skip -= 1

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)


def plain(value, limit):
    parser = PlainText()
    parser.feed(str(value or "")[:100000])
    return re.sub(r"\s+", " ", unescape(" ".join(parser.parts))).strip()[:limit]


def parse_document(payload):
    from defusedxml import ElementTree
    encoded = payload.get("data")
    if not isinstance(encoded, str) or len(encoded) > (MAX_XML + 2) // 3 * 4:
        raise ValueError("RSS document is too large")
    raw = base64.b64decode(encoded, validate=True)
    if not raw or len(raw) > MAX_XML:
        raise ValueError("RSS document is empty or too large")
    # Normalize UTF-8 only before both parsers; NUL/UTF-16 and DTDs are rejected.
    text = raw.decode("utf-8-sig", errors="strict")
    if "\x00" in text or re.search(r"<!\s*(?:DOCTYPE|ENTITY)\b", text, re.I):
        raise ValueError("DTD and entities are not accepted")
    document = ElementTree.fromstring(text, forbid_dtd=True, forbid_entities=True,
                                      forbid_external=True)
    local = document.tag.rsplit("}", 1)[-1].lower()
    if local not in {"rss", "feed", "rdf"}:
        raise ValueError("This response is not RSS or Atom")
    if sum(1 for _ in document.iter()) > 20000:
        raise ValueError("RSS document contains too many elements")
    stack = [(document, 0)]
    while stack:
        element, depth = stack.pop()
        if depth > 64:
            raise ValueError("RSS document nesting is too deep")
        stack.extend((child, depth + 1) for child in element)

    package = types.ModuleType("miobot_rsshub_upstream")
    package.__path__ = [str(Path(__file__).resolve().parent / "upstream")]
    sys.modules[package.__name__] = package
    from miobot_rsshub_upstream.xml_parser import XMLFeedParser

    entries, error = XMLFeedParser().parse(text)
    # A valid empty feed is a successful no-update result.
    if error and error != "RSS feed has no entries":
        raise ValueError("The feed could not be parsed")
    output = []
    remaining = 20000
    for entry in entries[:200]:
        summary = plain(entry.summary or entry.content, min(1600, remaining))
        remaining -= len(summary)
        output.append({"id": str(entry.id or "")[:2048],
                       "title": plain(entry.title, 300),
                       "url": str(entry.link or "")[:4096],
                       "summary": summary,
                       "publishedAt": entry.published.isoformat() if entry.published else None})
        if remaining <= 0:
            break
    return {"ok": True, "items": output,
            "parser": "RSSHub 2.1.4 XMLFeedParser", "truncated": len(entries) > len(output)}


if __name__ == "__main__":
    try:
        payload = json.loads(sys.stdin.buffer.read(3 * 1024 * 1024))
        print(json.dumps(parse_document(payload), ensure_ascii=False))
    except ModuleNotFoundError:
        print(json.dumps({"ok": False, "code": "PARSER_DEPENDENCY_MISSING",
                          "error": "RSS parsing dependencies are unavailable"}))
    except Exception:
        print(json.dumps({"ok": False, "code": "INVALID_FEED",
                          "error": "The response is not an accepted RSS/Atom document"}))
