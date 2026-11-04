"""Pure voice controls for one direct user message; no history or I/O.

Only a complete, unquoted command is recognized. ``once`` applies to the next
reply only; persistence belongs to the caller. A forced reply overrides the
saved mode, ``text`` disables speech, ``voice`` enables it, and ``auto`` samples
with ``random_value < probability`` (zero probability never selects speech).
"""

from __future__ import annotations

from dataclasses import dataclass
import math
import re
from typing import Literal


VoiceCommandKind = Literal["text", "voice", "auto", "once"]


@dataclass(frozen=True)
class VoiceCommand:
    kind: VoiceCommandKind


# Do not strip quotes, brackets, question marks, or punctuation inside a command.
_EDGE_PUNCTUATION = " \t\r\n\u3000，,。.!！；;：:、…"
_QUOTES = frozenset("\"'`“”‘’「」『』《》〈〉")
_PREFIXES = ("麻烦你", "麻烦", "请你", "劳驾", "拜托", "please", "请")
_SUFFIXES = ("谢谢你", "拜托了", "麻烦了", "谢谢", "多谢", "拜托")
_TAIL_PARTICLES = ("了吧", "了啊", "了呀", "了", "啦", "吧", "啊", "呀", "哦", "喔", "呗")
# Polite questions can only disable speech, never enable it or select a mode.
_POLITE_STOP_PREFIXES = ("能不能请你", "可不可以", "可以不可以", "能不能", "能否")
_STOP_REASONS = frozenset({
    "我现在不方便听", "现在不方便听", "不方便听", "我在外面",
    "旁边有人", "我旁边有人", "现在旁边有人",
})

_ALIASES: dict[VoiceCommandKind, frozenset[str]] = {
    "text": frozenset({
        "不要发语音", "别发语音", "不发语音", "不要再发语音", "别再发语音",
        "不要用语音", "别用语音", "关闭语音", "关掉语音", "关闭语音回复",
        "不要语音", "别语音", "只打字", "只打字回复我", "打字回复我",
        "用文字就行", "用文字就好", "只用文字就行", "只发文字就行",
        "只打字就行", "以后只打字",
        "只用文字", "只发文字", "只用文字回复", "只用文字回复我",
        "用文字回复我", "以后只用文字", "以后只发文字", "以后不要发语音",
        "以后别发语音", "以后用文字回复我", "文字模式",
    }),
    "once": frozenset({
        "这句用语音", "这次用语音", "这一句用语音", "这一次用语音",
        "这条用语音", "这句语音回复我", "这次语音回复我",
        "这次发语音", "这句发语音", "语音回复我", "用语音回复我",
        "发语音", "发条语音", "发一条语音", "给我发条语音",
        "给我发一条语音", "来条语音",
        "发个语音", "发一个语音", "给我发个语音", "给我发一个语音",
        "来个语音", "来一个语音", "发段语音", "发一段语音",
        "给我发段语音", "给我发一段语音", "来段语音", "来一段语音",
        "发个语音我听听", "给我发个语音我听听", "发条语音我听听",
        "给我发条语音我听听", "发段语音我听听", "给我发段语音我听听",
        "来个语音我听听", "来段语音我听听", "发个语音听听",
        "给我发个语音听听", "发个语音，我听听", "给我发个语音，我听听",
        "发条语音，我听听", "给我发条语音，我听听",
        "用语音说一句", "给我用语音说一句", "语音说一句", "用语音说一声",
        "你发个语音", "你给我发个语音", "你发个语音我听听",
        "你发条语音我听听", "你用语音说一句",
    }),
    "voice": frozenset({
        "以后都用语音", "以后都发语音", "以后只用语音", "以后只发语音",
        "以后用语音回复我", "以后都用语音回复我", "以后每次都用语音",
        "以后每次都用语音回复我", "每次都用语音", "一直用语音回复我",
        "始终用语音回复我",
    }),
    "auto": frozenset({
        "恢复自动", "恢复自动语音", "恢复自动语音模式", "自动语音模式",
        "恢复随机语音", "语音恢复自动", "偶尔发语音", "可以偶尔发语音",
        "可以偶尔用语音", "可以偶尔用语音回复我", "偶尔用语音回复我",
        "偶尔发语音就好",
    }),
}


def _match_exact_command(candidate: str) -> VoiceCommand | None:
    variants = [candidate]
    for particle in _TAIL_PARTICLES:
        if candidate.endswith(particle):
            variants.append(candidate[:-len(particle)])
            break
    for kind, aliases in _ALIASES.items():
        if any(variant in aliases for variant in variants):
            return VoiceCommand(kind=kind)
    return None


def _match_stop_with_reason(candidate: str) -> VoiceCommand | None:
    direct = _match_exact_command(candidate)
    if direct is not None:
        return direct if direct.kind == "text" else None
    parts = re.split(r"[，,。；;]", candidate)
    if len(parts) != 2:
        return None
    command, reason = (part.strip() for part in parts)
    if reason.startswith("因为"):
        reason = reason[2:]
    if reason not in _STOP_REASONS:
        return None
    parsed = _match_exact_command(command)
    return parsed if parsed is not None and parsed.kind == "text" else None


def parse_voice_command(text: str) -> VoiceCommand | None:
    """Recognize a direct exact command, allowing edge punctuation and courtesy.

    Quotes, ordinary questions, narration and conditions do not match. Only
    an allowlisted polite stop request or a stop plus one allowlisted reason
    can extend an exact command. Supply only the current direct plain text.
    """
    if not isinstance(text, str):
        return None
    candidate = text.strip()
    if (
        not candidate
        or any(char in candidate for char in _QUOTES)
        or "\n" in candidate
        or "\r" in candidate
    ):
        return None
    candidate = candidate.strip(_EDGE_PUNCTUATION)
    question = "?" in candidate or "？" in candidate
    if question:
        if candidate.count("?") + candidate.count("？") != 1 or candidate[-1] not in "?？":
            return None
        candidate = candidate[:-1].strip(_EDGE_PUNCTUATION)
    for prefix in _PREFIXES:
        if candidate.casefold().startswith(prefix):
            candidate = candidate[len(prefix):].strip(_EDGE_PUNCTUATION)
            break
    for suffix in _SUFFIXES:
        if candidate.endswith(suffix):
            candidate = candidate[:-len(suffix)].strip(_EDGE_PUNCTUATION)
            break
    for prefix in _POLITE_STOP_PREFIXES:
        if candidate.startswith(prefix):
            return _match_stop_with_reason(candidate[len(prefix):].strip(_EDGE_PUNCTUATION))
    if question:
        return None
    return _match_exact_command(candidate) or _match_stop_with_reason(candidate)


def should_speak(
    mode: str,
    forced_once: bool,
    probability: float,
    random_value: float,
) -> bool:
    """Choose speech without I/O; explicit once/voice bypass auto probability.

    Invalid modes or invalid auto sampling values fail closed. Values outside
    the probability range are clamped; random samples must be in [0, 1).
    """
    if forced_once:
        return True
    if mode == "text":
        return False
    if mode == "voice":
        return True
    if mode != "auto":
        return False
    try:
        chance = float(probability)
        sample = float(random_value)
    except (TypeError, ValueError, OverflowError):
        return False
    if not math.isfinite(chance) or not math.isfinite(sample):
        return False
    if not 0.0 <= sample < 1.0:
        return False
    return sample < max(0.0, min(1.0, chance))
