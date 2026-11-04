"""Exercise the actual attributed RSSHub parser, no network or private data."""
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("miobot_rss_parser_smoke", ROOT / "integrations/rsshub/parse_feed.py")
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


def parse(value):
    return adapter.parse_document({"data": base64.b64encode(value if isinstance(value, bytes) else value.encode()).decode()})


class ParserTests(unittest.TestCase):
    def test_rss_title_html_summary_and_date_use_real_upstream_parser(self):
        data = parse('''<rss version="2.0"><channel><title>Fixture</title><link>https://example.org/</link><item><guid>fixture-1</guid><title>Title &amp; info</title><link>https://example.org/1</link><description><![CDATA[Hello <b>world</b><script>hidden</script>]]></description><pubDate>Thu, 05 Nov 2026 00:00:00 GMT</pubDate></item></channel></rss>''')
        self.assertEqual(data["parser"], "RSSHub 2.1.4 XMLFeedParser")
        item = data["items"][0]
        self.assertEqual(item["title"], "Title & info")
        self.assertEqual(item["summary"], "Hello world")
        self.assertTrue(item["publishedAt"].startswith("2026-11-05"))

    def test_atom_id_link_and_content(self):
        data = parse('''<feed xmlns="http://www.w3.org/2005/Atom"><title>Fixture</title><id>urn:fixture</id><entry><id>urn:fixture:2</id><title>Entry</title><link href="https://example.org/2"/><summary>Atom text</summary></entry></feed>''')
        self.assertEqual(data["items"][0]["url"], "https://example.org/2")
        self.assertEqual(data["items"][0]["summary"], "Atom text")

    def test_valid_empty_feed_is_no_update(self):
        self.assertEqual(parse('<rss version="2.0"><channel><title>Empty</title></channel></rss>')["items"], [])

    def test_dtd_entities_and_utf16_are_rejected(self):
        for value in ['<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss>&x;</rss>', '<!DOCTYPE rss><rss/>', '<rss/>'.encode('utf-16')]:
            with self.assertRaises((ValueError, UnicodeError)):
                parse(value)

    def test_non_feed_html_is_rejected(self):
        with self.assertRaises(ValueError):
            parse('<html><body>Not a feed</body></html>')

    def test_deep_and_oversized_documents_are_rejected(self):
        for value in ['<rss>'+'<x>'*100+'</x>'*100+'</rss>', 'x'*(2*1024*1024+1)]:
            with self.assertRaises(ValueError):
                parse(value)

    def test_summary_output_is_bounded(self):
        data = parse('<rss><channel><title>Fixture</title>'+''.join(f'<item><title>Entry {i}</title><link>https://example.org/{i}</link><description>'+('a'*8000)+'</description></item>' for i in range(60))+'</channel></rss>')
        self.assertLessEqual(sum(len(x['summary']) for x in data['items']), 20000)
        self.assertTrue(data['truncated'])

    def test_original_parser_source_bytes_match_provenance(self):
        manifest=json.loads((ROOT/'integrations/rsshub/PROVENANCE.json').read_text())
        for entry in manifest['sourceFiles']:
            if entry['path'].endswith('.py'):
                source=ROOT/'integrations/rsshub/upstream'/Path(entry['path']).name
                self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(),entry['sha256'])


if __name__ == '__main__':
    unittest.main()
