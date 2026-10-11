#!/usr/bin/python3
"""Read-only exact-object and permission verifier for a staged/final install."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import stat
import sys


def digest(path: pathlib.Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def mode_bits(info: os.stat_result) -> str:
    return f"{stat.S_IMODE(info.st_mode):04o}"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True, type=pathlib.Path)
    parser.add_argument("--manifest", required=True, type=pathlib.Path)
    parser.add_argument("--manifest-sha256", required=True)
    args = parser.parse_args()
    root = args.root.resolve(strict=True)
    manifest_path = args.manifest.resolve(strict=True)
    if digest(manifest_path) != args.manifest_sha256:
        print("manifest digest mismatch", file=sys.stderr)
        return 1
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    install_root = pathlib.PurePosixPath(manifest["install_root"])
    expected: dict[str, dict] = {}
    errors: list[str] = []

    for item in manifest["objects"]:
        destination = pathlib.PurePosixPath(item["destination"])
        relative = destination.relative_to(install_root)
        actual = root if str(relative) == "." else root.joinpath(*relative.parts)
        key = str(actual)
        expected[key] = item
        try:
            info = actual.lstat()
        except OSError:
            errors.append(f"missing object: {item['destination']}")
            continue
        kind = item["type"]
        observed_kind = "symlink" if stat.S_ISLNK(info.st_mode) else "directory" if stat.S_ISDIR(info.st_mode) else "regular-file" if stat.S_ISREG(info.st_mode) else "other"
        if observed_kind != kind:
            errors.append(f"type mismatch: {item['destination']}")
            continue
        if info.st_uid != item["uid"] or info.st_gid != item["gid"]:
            errors.append(f"ownership mismatch: {item['destination']}")
        if mode_bits(info) != item["mode"]:
            errors.append(f"mode mismatch: {item['destination']}")
        if kind == "regular-file" and digest(actual) != item["sha256"]:
            errors.append(f"content mismatch: {item['destination']}")
        if kind == "symlink" and os.readlink(actual) != item["target"]:
            errors.append(f"symlink target mismatch: {item['destination']}")

    actual_objects: set[str] = {str(root)}
    for current, dirs, files in os.walk(root, topdown=True, followlinks=False):
        base = pathlib.Path(current)
        for name in list(dirs):
            candidate = base / name
            actual_objects.add(str(candidate))
            if candidate.is_symlink():
                dirs.remove(name)
        for name in files:
            actual_objects.add(str(base / name))
    manifest_installed = root / "share" / "trusted-object-manifest.json"
    actual_objects.add(str(manifest_installed))
    extras = actual_objects - set(expected) - {str(manifest_installed)}
    missing = set(expected) - actual_objects
    for item in sorted(extras):
        errors.append(f"unmanifested object: {item}")
    for item in sorted(missing):
        errors.append(f"manifest object absent from tree: {item}")

    try:
        info = manifest_installed.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_gid != 0 or mode_bits(info) != "0444":
            errors.append("installed manifest metadata mismatch")
        if digest(manifest_installed) != args.manifest_sha256:
            errors.append("installed manifest content mismatch")
    except OSError:
        errors.append("installed manifest missing")

    for item in manifest["parent_directories"]:
        p = pathlib.Path(item["path"])
        try:
            info = p.lstat()
            if info.st_uid != item["uid"] or info.st_gid != item["gid"] or mode_bits(info) != item["mode"]:
                errors.append(f"protected parent metadata mismatch: {p}")
            if (info.st_mode & 0o022) != 0:
                errors.append(f"writable protected parent: {p}")
        except OSError:
            errors.append(f"protected parent missing: {p}")

    for item in manifest["system_dependency_parent_directories"]:
        p = pathlib.Path(item["path"])
        try:
            info = p.lstat()
            kind = "symlink" if stat.S_ISLNK(info.st_mode) else "directory" if stat.S_ISDIR(info.st_mode) else "other"
            if kind != item["type"] or info.st_uid != item["uid"] or info.st_gid != item["gid"] or mode_bits(info) != item["mode"]:
                errors.append(f"system dependency parent mismatch: {p}")
            if kind == "symlink" and os.readlink(p) != item["target"]:
                errors.append(f"system dependency parent target mismatch: {p}")
            if (info.st_mode & 0o022) != 0 and kind != "symlink":
                errors.append(f"writable system dependency parent: {p}")
        except OSError:
            errors.append(f"system dependency parent missing: {p}")

    for item in manifest["system_runtime_dependencies"]:
        path = pathlib.Path(item["path"])
        resolved = pathlib.Path(item["resolved_path"])
        try:
            entry = path.lstat()
            actual_link = path.is_symlink()
            if actual_link != item["path_is_symlink"]:
                errors.append(f"system dependency link-type mismatch: {path}")
            if actual_link and os.readlink(path) != item["symlink_target"]:
                errors.append(f"system dependency link-target mismatch: {path}")
            if entry.st_uid != item["entry_uid"] or entry.st_gid != item["entry_gid"] or mode_bits(entry) != item["entry_mode"]:
                errors.append(f"system dependency entry metadata mismatch: {path}")
            info = resolved.stat()
            if info.st_uid != item["uid"] or info.st_gid != item["gid"] or mode_bits(info) != item["mode"] or digest(resolved) != item["sha256"]:
                errors.append(f"system dependency identity mismatch: {resolved}")
            if (info.st_mode & 0o022) != 0:
                errors.append(f"writable system dependency: {resolved}")
        except OSError:
            errors.append(f"system dependency missing: {path}")

    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        print(json.dumps({"passed": False, "errors": len(errors)}))
        return 1
    print(json.dumps({"passed": True, "objects": len(expected), "systemDependencies": len(manifest["system_runtime_dependencies"])}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
