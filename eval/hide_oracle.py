"""Load Python oracle sources once from memory and leave their workspace paths empty."""


def _init():
    import importlib.machinery
    import json
    import os
    import pathlib
    import sys

    saved = {}
    try:
        for file in json.loads(os.environ.get("NEXUS_HIDDEN_FILES", "[]")):
            absolute = str(pathlib.Path(file).resolve())
            if absolute.endswith(".py"):
                with open(absolute, "rb") as source:
                    saved[absolute] = source.read()
                with open(absolute, "wb") as source:
                    source.write(b"")
    finally:
        os.environ.pop("NEXUS_HIDDEN_FILES", None)

    original_get_data = importlib.machinery.SourceFileLoader.get_data
    if saved:
        def load_hidden_once(loader, path):
            absolute = str(pathlib.Path(path).resolve())
            if absolute in saved:
                contents = saved.pop(absolute)
                if not saved:
                    importlib.machinery.SourceFileLoader.get_data = original_get_data
                return contents
            return original_get_data(loader, path)

        importlib.machinery.SourceFileLoader.get_data = load_hidden_once

    sys.modules.pop(__name__, None)
    runner_dir = str(pathlib.Path(__file__).resolve().parent)
    sys.path[:] = [entry for entry in sys.path if entry not in ("/runner", runner_dir)]


_init()
del _init
