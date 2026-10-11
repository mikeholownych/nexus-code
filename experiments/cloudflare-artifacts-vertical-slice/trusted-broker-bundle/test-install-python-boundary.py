#!/usr/bin/python3
"""Prove isolated privileged Python invocation defeats script-dir import shadowing."""
from __future__ import annotations

import json
import os
import pathlib
import subprocess
import sys
import tempfile


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="nexus-python-boundary-") as temporary:
        root = pathlib.Path(temporary)
        marker = root / "import-shadow.marker"
        (root / "argparse.py").write_text(
            f"from pathlib import Path; Path({str(marker)!r}).write_text('executed')\n",
            encoding="utf-8",
        )
        script = root / "root-helper.py"
        script.write_text("import argparse\nprint('helper-started')\n", encoding="utf-8")
        hostile_environment = {"PATH": "/usr/bin:/bin", "PYTHONPATH": str(root), "HOME": str(root)}
        vulnerable = subprocess.run(
            [sys.executable, str(script)], cwd=root, env=hostile_environment,
            capture_output=True, text=True, timeout=10,
        )
        negative_control_detected = vulnerable.returncode == 0 and marker.exists()
        marker.unlink(missing_ok=True)
        protected = subprocess.run(
            [sys.executable, "-I", "-S", str(script)], cwd=root, env=hostile_environment,
            capture_output=True, text=True, timeout=10,
        )
        isolated_execution_safe = protected.returncode == 0 and not marker.exists() and "helper-started" in protected.stdout
        result = {
            "negativeControlImportShadowExecuted": negative_control_detected,
            "isolatedPythonRejectedImportShadow": isolated_execution_safe,
            "markerAbsentAfterIsolatedExecution": not marker.exists(),
        }
        result["passed"] = all(result.values())
        print(json.dumps(result, sort_keys=True))
        return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
