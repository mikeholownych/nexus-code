import re

_PART = re.compile(r"(\d+)([hms])")
_UNITS = {"h": 3600, "m": 3600, "s": 1}


def parse_duration(text):
    """Parse a duration like '1h30m', '45m' or '20s' into seconds."""
    text = text.strip().lower()
    if not text or _PART.sub("", text):
        raise ValueError(f"invalid duration: {text!r}")
    return sum(int(n) * _UNITS[u] for n, u in _PART.findall(text))
