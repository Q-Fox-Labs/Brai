# Закреплённая проверка синтаксиса MarkdownV2 из тестового стенда Hermes.
import re
_MDV2_RESERVED = set("_*[]()~`>#+-=|{}.!")
_MDV2_LINK = re.compile(r"\[((?:\\.|[^\]\\])*)\]\(((?:\\.|[^)\\])*)\)")

def mdv2_error(text: str) -> str | None:
    """The Bot API's ``can't parse entities`` reason for ``text`` in MarkdownV2, or None if it parses.

    A faithful subset of the server's parser: escapes, code/pre spans, links, the paired style
    markers (``*`` ``_`` ``__`` ``~`` ``||``) and line-leading ``>`` quotes. Any other reserved
    character must carry a preceding backslash.
    """
    i, n, open_marks = 0, len(text), []
    while i < n:
        ch = text[i]
        if ch == "\\":
            i += 2
            continue
        if text.startswith("```", i):
            end = text.find("```", i + 3)
            if end < 0:
                return "Can't find end of Pre entity at byte offset %d" % i
            i = end + 3
            continue
        if ch == "`":
            end = text.find("`", i + 1)
            if end < 0:
                return "Can't find end of Code entity at byte offset %d" % i
            i = end + 1
            continue
        if ch == "[":
            m = _MDV2_LINK.match(text, i)
            if not m:
                return "Character '[' is reserved and must be escaped with the preceding '\\'"
            i = m.end()
            continue
        if ch == ">" and (i == 0 or text[i - 1] == "\n"):
            i += 1
            continue
        mark = next((mk for mk in ("||", "__", "*", "_", "~") if text.startswith(mk, i)), None)
        if mark is not None:
            if open_marks and open_marks[-1] == mark:
                open_marks.pop()
            else:
                open_marks.append(mark)
            i += len(mark)
            continue
        if ch in _MDV2_RESERVED:
            return f"Character '{ch}' is reserved and must be escaped with the preceding '\\'"
        i += 1
    if open_marks:
        return f"Can't find end of the entity starting with '{open_marks[-1]}'"
    return None
