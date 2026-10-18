"""Load Python oracle sources once from memory and leave their workspace paths empty."""
import importlib.machinery
import os
import pathlib

_saved = {}
try:
    for _file in __import__("json").loads(os.environ.get("NEXUS_HIDDEN_FILES", "[]")):
        _absolute = str(pathlib.Path(_file).resolve())
        if _absolute.endswith(".py"):
            with open(_absolute, "rb") as _source:
                _saved[_absolute] = _source.read()
            with open(_absolute, "wb") as _source:
                _source.write(b"")
finally:
    os.environ.pop("NEXUS_HIDDEN_FILES", None)

_get_data = importlib.machinery.SourceFileLoader.get_data


def _load_hidden_once(loader, path):
    absolute = str(pathlib.Path(path).resolve())
    if absolute in _saved:
        return _saved.pop(absolute)
    return _get_data(loader, path)


importlib.machinery.SourceFileLoader.get_data = _load_hidden_once
