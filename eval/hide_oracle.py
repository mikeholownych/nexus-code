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
                sys.modules.pop("sitecustomize", None)
                return contents
            if absolute.endswith(".py") and not absolute.startswith(("/usr/", "/lib/", "/opt/", "/home/")):
                saved.clear()
                importlib.machinery.SourceFileLoader.get_data = original_get_data
            return original_get_data(loader, path)

        importlib.machinery.SourceFileLoader.get_data = load_hidden_once

    runner_dir = str(pathlib.Path(__file__).resolve().parent)
    sys.path[:] = [entry for entry in sys.path if entry not in ("/runner", runner_dir)]
    pythonpath = os.environ.get("PYTHONPATH", "")
    os.environ["PYTHONPATH"] = os.pathsep.join(entry for entry in pythonpath.split(os.pathsep) if entry not in ("/runner", runner_dir))

    # sitecustomize is imported before site.execusercustomize runs. Remove it only after
    # that import has returned so importlib's module cleanup still sees its module entry.
    import site
    original_execusercustomize = site.execusercustomize
    def execusercustomize_without_sitecustomize():
        try:
            return original_execusercustomize()
        finally:
            sys.modules.pop("sitecustomize", None)
    site.execusercustomize = execusercustomize_without_sitecustomize


_init()
del _init
