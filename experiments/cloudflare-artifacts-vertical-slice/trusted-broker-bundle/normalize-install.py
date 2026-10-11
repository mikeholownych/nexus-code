#!/usr/bin/python3
"""Apply deterministic read-only modes to a staged broker installation."""
from __future__ import annotations

import argparse
import os
import pathlib
import stat


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True, type=pathlib.Path)
    parser.add_argument("--launcher", required=True)
    parser.add_argument("--runtime", required=True)
    args = parser.parse_args()
    root = args.root.resolve(strict=True)
    if os.geteuid() != 0:
        raise SystemExit("normalization must run during operator installation")
    for current, dirs, files in os.walk(root, topdown=True, followlinks=False):
        directory = pathlib.Path(current)
        for name in list(dirs):
            p = directory / name
            if p.is_symlink():
                dirs.remove(name)
            else:
                os.chmod(p, 0o555)
        for name in files:
            p = directory / name
            if p.is_symlink():
                continue
            os.chmod(p, 0o444)
    os.chmod(root, 0o755)
    os.chmod(root / args.launcher, 0o555)
    os.chmod(root / args.runtime, 0o555)


if __name__ == "__main__":
    main()
