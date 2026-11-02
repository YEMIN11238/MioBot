"""MioBot adaptation of zexuan604's dafeiyu_clean/clean.py.

The original marker patterns are retained. Fenced and inline code examples are
protected so technical conversations may discuss the markers without damage.
See NOTICE.md and the retained MIT license from the source configuration pack.
"""
import re

_BAR = r"[|｜]"
_PATTERNS = [
    re.compile(r"<\s*system_reminder\s*>.*?<\s*/\s*system_reminder\s*>", re.S | re.I),
    re.compile(r"<\s*system_reminder\s*>[^\n]*", re.I),
    re.compile(r"<\s*/\s*system_reminder\s*>", re.I),
    re.compile(rf"<\s*{_BAR}+\s*DSML\s*{_BAR}+\s*function_calls\s*>.*?(?:<\s*/\s*{_BAR}+\s*DSML\s*{_BAR}+\s*function_calls\s*>|$)", re.S | re.I),
    re.compile(rf"<\s*/?\s*{_BAR}+\s*DSML\s*{_BAR}+[^>]*>", re.I),
    re.compile(r"<｜tool▁calls▁begin｜>.*?(?:<｜tool▁calls▁end｜>|$)", re.S),
    re.compile(r"<｜[^｜>\n]*▁[^｜>\n]*｜>"),
    re.compile(r"<\s*tool_call\s*>.*?(?:<\s*/\s*tool_call\s*>|$)", re.S | re.I),
    re.compile(r"User ID:\s*\d+\s*,\s*Nickname:[^\n<]*"),
]
_HINT = re.compile(r"system_reminder|DSML|tool▁|tool_call|User ID:", re.I)
_FENCE = re.compile(r"(?m)^[ \t]{0,3}(`{3,}|~{3,})[^\r\n]*(?:\r?\n|$)")
_INLINE = re.compile(r"(?P<ticks>`+)(?:(?!(?P=ticks))[^\r\n])*?(?P=ticks)")


def dirty(text: str) -> bool:
    return isinstance(text, str) and bool(_HINT.search(text))


def _clean_prose(text: str) -> str:
    """Apply the upstream rules outside protected code spans only."""
    if not dirty(text):
        return text
    for pattern in _PATTERNS:
        text = pattern.sub("", text)
    return text


def clean(text: str) -> str:
    if not dirty(text):
        return text
    # Replace code before removing blocks. Applying the rules to separate prose
    # slices could accidentally retain a backtick-quoted fragment INSIDE an
    # internal reminder/tool block. A whole block must still disappear.
    prefix = "\x00MIOBOT_CODE_"
    while prefix in text:
        prefix += "_"
    protected = {}

    def protect(code):
        token = prefix + str(len(protected)) + "\x00"
        protected[token] = code
        return token

    def mask_inline(value):
        return _INLINE.sub(lambda match: protect(match.group()), value)

    pieces, cursor = [], 0
    while opening := _FENCE.search(text, cursor):
        pieces.append(mask_inline(text[cursor:opening.start()]))
        fence = opening.group(1)
        closing = re.compile(
            r"(?m)^[ \t]{0,3}" + re.escape(fence[0]) + "{" + str(len(fence)) + r",}[ \t]*(?:\r?\n|$)"
        ).search(text, opening.end())
        end = closing.end() if closing else len(text)
        pieces.append(protect(text[opening.start():end]))
        cursor = end
    pieces.append(mask_inline(text[cursor:]))
    result = _clean_prose("".join(pieces))
    for token, code in protected.items():
        result = result.replace(token, code)
    if result == text:
        return text
    # Do not normalize code indentation/content; trimming only removes the
    # surrounding whitespace left by erased internal marker blocks.
    return result.strip()
