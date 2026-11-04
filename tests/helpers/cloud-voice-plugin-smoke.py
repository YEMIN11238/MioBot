"""Actual pinned AstrBot imports and isolated optional voice/singing events.

No paid synthesis, QQ gateway or live user state is accessed.
"""
from __future__ import annotations
import atexit
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.dont_write_bytecode = True
isolated = tempfile.TemporaryDirectory(prefix='miobot-cloud-voice-')
atexit.register(isolated.cleanup)
os.environ['ASTRBOT_ROOT'] = isolated.name
os.environ['MIOBOT_MANAGED_CLOUD_PLUGINS'] = '1'
sys.path.insert(0, str(ROOT / '.runtime/astrbot-source'))

from astrbot.api.message_components import Plain, Record
from astrbot.core.platform.astr_message_event import AstrMessageEvent
from astrbot.core.platform.astrbot_message import AstrBotMessage, MessageMember
from astrbot.core.platform.message_type import MessageType
from astrbot.core.platform.platform_metadata import PlatformMetadata
from astrbot.core.provider.register import llm_tools, provider_cls_map


def load(name):
    path = ROOT / 'integrations/cloud-plugins' / name
    spec = importlib.util.spec_from_file_location('cloud_fixture_' + name, path / 'main.py', submodule_search_locations=[str(path)])
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


seed = load('astrbot_plugin_seed_audio_tts')
sing = load('astrbot_plugin_dafeiyu_sing')
OWNER = 'fixture-qq:FriendMessage:10001'


def event(text='给我唱首歌', sender='10001', platform='aiocqhttp'):
    message = AstrBotMessage()
    message.type = MessageType.FRIEND_MESSAGE
    message.self_id = 'fixture-bot'
    message.session_id = sender
    message.message_id = 'fixture-message'
    message.sender = MessageMember(user_id=sender, nickname='fixture')
    message.message = [Plain(text)]
    message.message_str = text
    message.raw_message = {}
    native = AstrMessageEvent(text, message, PlatformMetadata(platform, 'isolated fixture', 'fixture-qq'), sender)
    native.sent = []
    async def capture(chain):
        native.sent.append(chain)
    native.send = capture
    return native


class Context:
    def get_all_tts_providers(self):
        raise AssertionError('managed component must not borrow a global TTS provider')
    def get_config(self, **kwargs):
        raise AssertionError('managed singing credentials must not read global config')


class NativeImportAndPolicy(unittest.TestCase):
    def test_native_tools_and_provider_registered(self):
        self.assertIsNotNone(provider_cls_map.get('seed_audio_tts'))
        self.assertIsNotNone(llm_tools.get_func('sing_song'))
        self.assertIsNotNone(llm_tools.get_func('set_voice_reply_mode'))

    def test_managed_seed_needs_exact_native_owner_session(self):
        plugin = seed.SeedAudioTTSPlugin(Context(), {'owner_session': OWNER})
        self.assertTrue(plugin._is_owner(event('发条语音')))
        self.assertFalse(plugin._is_owner(event('发条语音', sender='10002')))
        self.assertFalse(plugin._is_owner(event('发条语音', platform='webchat')))
        plugin.config['owner_session'] = ''
        self.assertFalse(plugin._is_owner(event('发条语音')))

    def test_seed_uses_only_explicit_credentials_and_low_default_probability(self):
        plugin = seed.SeedAudioTTSPlugin(Context(), {'owner_session': OWNER})
        self.assertIsNone(plugin._whole_reply_provider())
        plugin.config.update(app_id='fixture-app', access_key='fixture-private-token')
        provider = plugin._whole_reply_provider()
        self.assertIsInstance(provider, seed.ProviderSeedAudioTTS)
        self.assertEqual(provider.app_id, 'fixture-app')
        self.assertEqual(provider.reply_probability, 0.08)
        self.assertTrue(provider.whole_reply)
        for value in [-1, 2, float('nan'), 'not-a-probability']:
            plugin.config['reply_probability'] = value
            self.assertIsNone(plugin._whole_reply_provider())

    def test_stop_and_once_commands_remain_deterministic(self):
        self.assertEqual(seed.parse_voice_command('不要发语音').kind, 'text')
        self.assertEqual(seed.parse_voice_command('发个语音').kind, 'once')
        self.assertFalse(seed.should_speak('text', False, 1, 0))
        self.assertTrue(seed.should_speak('text', True, 0, 1))

    def test_song_owner_direct_request_and_native_platform_required(self):
        plugin = sing.DafeiyuSing(Context(), {'owner_session': OWNER})
        self.assertTrue(plugin._managed_request_allowed(event()))
        self.assertTrue(plugin._managed_request_allowed(event('给我唱个生日歌')))
        self.assertFalse(plugin._managed_request_allowed(event(sender='10002')))
        self.assertFalse(plugin._managed_request_allowed(event(platform='webchat')))
        for text in ['你会唱歌吗', '唱歌多少钱', '如果我说给我唱首歌', '他说“给我唱首歌”', '提醒我明天唱歌']:
            self.assertFalse(plugin._managed_request_allowed(event(text)), text)
        timed = event()
        timed.set_extra('cron_job', {'id': 'fixture'})
        self.assertFalse(plugin._managed_request_allowed(timed))

    def test_song_does_not_borrow_other_provider_credentials(self):
        plugin = sing.DafeiyuSing(Context(), {'owner_session': OWNER})
        self.assertIsNone(plugin._doubao_creds())
        plugin.conf.update(doubao_app_id='fixture-app', doubao_access_token='fixture-token')
        self.assertEqual(plugin._doubao_creds(), ('fixture-app', 'fixture-token'))

    def test_only_intended_config_fields_are_marked_secret_and_no_private_audio(self):
        base = ROOT / 'integrations/cloud-plugins'
        for name, fields in [('astrbot_plugin_seed_audio_tts', ['app_id', 'access_key']), ('astrbot_plugin_dafeiyu_sing', ['doubao_app_id', 'doubao_access_token'])]:
            schema = json.loads((base / name / '_conf_schema.json').read_text())
            for field in fields:
                self.assertTrue(schema[field]['_secret'])
                self.assertEqual(schema[field]['default'], '')
            self.assertTrue((base / name / 'LICENSE').exists())
        self.assertFalse((base / 'astrbot_plugin_dafeiyu_sing/sing_server/voice').exists())


class SongExecution(unittest.IsolatedAsyncioTestCase):
    async def test_missing_credentials_is_truthful_and_starts_no_task(self):
        plugin = sing.DafeiyuSing(Context(), {'owner_session': OWNER})
        result = await plugin.sing_song(event(), '生日快乐', '测试')
        self.assertIn('没有开始', result)
        self.assertFalse(plugin.tasks)
        self.assertFalse(plugin.singing)

    async def test_denied_request_cannot_probe_or_synthesize(self):
        plugin = sing.DafeiyuSing(Context(), {'owner_session': OWNER})
        async def forbidden():
            raise AssertionError('denied request reached readiness/synthesis')
        plugin._ready = forbidden
        result = await plugin.sing_song(event(platform='webchat'), '生日快乐', '测试')
        self.assertIn('未执行', result)
        self.assertFalse(plugin.tasks)

    async def test_authorized_song_uses_original_record_send_and_cleans_busy_state(self):
        plugin = sing.DafeiyuSing(Context(), {'owner_session': OWNER})
        path = Path(isolated.name) / 'fixture.wav'
        path.write_bytes(b'RIFF' + b'\0' * 40)
        async def ready():
            return True
        async def fake_synthesis(evt, melody, lyrics):
            self.assertEqual(melody, '生日快乐')
            return str(path)
        plugin._ready = ready
        plugin._sing_doubao = fake_synthesis
        native = event()
        result = await plugin.sing_song(native, '生日快乐', '这是测试')
        self.assertIn('已经开始', result)
        await asyncio.gather(*list(plugin.tasks))
        self.assertEqual(len(native.sent), 1)
        self.assertIsInstance(native.sent[0].chain[0], Record)
        self.assertFalse(plugin.singing)
        await plugin.terminate()

    async def test_failed_generation_sends_failure_text_not_success(self):
        plugin = sing.DafeiyuSing(Context(), {'owner_session': OWNER})
        async def fail(*args):
            raise RuntimeError('isolated synthesis fixture failure')
        plugin._sing_doubao = fail
        native = event()
        await plugin._sing_and_send(native, '生日快乐', '这是测试')
        self.assertEqual(len(native.sent), 1)
        self.assertIsInstance(native.sent[0].chain[0], Plain)
        self.assertIn('没有生成或发送成功', native.sent[0].chain[0].text)
        self.assertFalse(plugin.singing)


if __name__ == '__main__':
    unittest.main()
