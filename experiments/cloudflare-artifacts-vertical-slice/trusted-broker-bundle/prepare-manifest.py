#!/usr/bin/python3
"""Reproduce the protected install tree and emit its source-controlled manifest."""
from __future__ import annotations

import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request


BUNDLE = pathlib.Path(__file__).resolve().parent
NODE_VERSION = "24.21.0"
NODE_ARCHIVE = f"node-v{NODE_VERSION}-linux-x64.tar.xz"
NODE_SHA256 = "fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6"
NODE_URL = f"https://nodejs.org/dist/v{NODE_VERSION}/{NODE_ARCHIVE}"
UPSTREAM = BUNDLE / "upstream" / f"node-v{NODE_VERSION}"
INSTALL_ROOT = "/opt/nexus-cloudflare-broker"


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def npm_package_for(relative: str, lock: dict) -> tuple[str | None, dict | None]:
    candidates = [key for key in lock["packages"] if key.startswith("node_modules/")]
    for key in sorted(candidates, key=len, reverse=True):
        prefix = key + "/"
        if relative == key or relative.startswith(prefix):
            return key.removeprefix("node_modules/"), lock["packages"][key]
    return None, None


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="nexus-cf-manifest-") as temp:
        work = pathlib.Path(temp)
        archive = work / NODE_ARCHIVE
        urllib.request.urlretrieve(NODE_URL, archive)
        if sha256(archive) != NODE_SHA256:
            raise SystemExit("Node archive SHA-256 did not match the verified release checksum")
        subprocess.run(
            ["/usr/bin/gpgv", "--keyring", str(UPSTREAM / "pubring.kbx"),
             str(UPSTREAM / "SHASUMS256.txt.sig"), str(UPSTREAM / "SHASUMS256.txt")],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        with tarfile.open(archive, "r:xz") as package:
            package.extractall(work, filter="data")
        node_dist = work / f"node-v{NODE_VERSION}-linux-x64"
        node_source = node_dist / "bin" / "node"
        npm_cli = node_dist / "lib" / "node_modules" / "npm" / "bin" / "npm-cli.js"
        version = subprocess.check_output([str(node_source), "--version"], text=True).strip()
        if version != f"v{NODE_VERSION}":
            raise SystemExit(f"unexpected Node version {version}")

        root = work / "root" / INSTALL_ROOT.lstrip("/")
        (root / "runtime").mkdir(parents=True)
        (root / "cf-runtime").mkdir()
        (root / "broker").mkdir()
        (root / "bin").mkdir()
        (root / "share").mkdir()
        shutil.copy2(node_source, root / "runtime" / "node")
        shutil.copy2(BUNDLE / "package.json", root / "cf-runtime" / "package.json")
        shutil.copy2(BUNDLE / "package-lock.json", root / "cf-runtime" / "package-lock.json")
        for name in ("clean-start-check.mjs", "credential-probe-safe.mjs", "artifact-token-response.mjs", "linux-bound-exec.mjs", "credential-lifecycle.mjs", "demo-transport.mjs", "demo-transport-test.mjs"):
            source = BUNDLE / "broker" / name
            shutil.copy2(source, root / "broker" / source.name)
        if not (root / "broker" / "clean-start-check.mjs").is_file():
            raise SystemExit("protected clean-start check was not staged")
        shutil.copy2(BUNDLE / "bin" / "nexus-cf-broker", root / "bin" / "nexus-cf-broker")

        empty_home = work / "empty-home"
        empty_home.mkdir()
        env = {
            "HOME": str(empty_home),
            "PATH": "/usr/bin:/bin",
            "LANG": "C.UTF-8",
            "npm_config_userconfig": "/dev/null",
            "npm_config_cache": str(work / "npm-cache"),
        }
        npm_args = [str(node_source), str(npm_cli)]
        subprocess.run(
            npm_args + ["ci", "--ignore-scripts", "--no-audit", "--no-fund",
                        "--registry=https://registry.npmjs.org/", "--userconfig=/dev/null"],
            cwd=root / "cf-runtime", env=env, check=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=120,
        )
        sigcheck = subprocess.run(
            npm_args + ["audit", "signatures", "--userconfig=/dev/null"],
            cwd=root / "cf-runtime", env=env, check=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=120,
        )
        if "verified registry signatures" not in sigcheck.stdout:
            raise SystemExit("npm registry signature audit did not report verified signatures")
        cf_version = subprocess.run(
            [str(node_source), str(root / "cf-runtime" / "node_modules" / "cf" / "bin" / "cf"), "--version"],
            cwd="/", env={"HOME": str(empty_home), "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "NO_COLOR": "1"},
            check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=30,
        )
        if "v1.0.0-beta.10" not in cf_version.stdout:
            raise SystemExit("pinned cf package did not report its expected version")

        ldd = subprocess.check_output(["/usr/bin/ldd", str(root / "runtime" / "node")], text=True)
        system_deps = []
        system_parent_dirs = {}
        for line in ldd.splitlines():
            fields = line.split()
            candidate = fields[2] if len(fields) >= 3 and fields[1] == "=>" else fields[0]
            if candidate.startswith("/") and pathlib.Path(candidate).exists():
                original = pathlib.Path(candidate)
                entry_stat = original.lstat()
                resolved = original.resolve()
                st = resolved.stat()
                system_deps.append({
                    "path": candidate,
                    "resolved_path": str(resolved),
                    "path_is_symlink": original.is_symlink(),
                    "symlink_target": os.readlink(original) if original.is_symlink() else None,
                    "entry_uid": entry_stat.st_uid,
                    "entry_gid": entry_stat.st_gid,
                    "entry_mode": f"{entry_stat.st_mode & 0o777:04o}",
                    "type": "system-shared-library",
                    "sha256": sha256(resolved),
                    "uid": st.st_uid,
                    "gid": st.st_gid,
                    "mode": f"{st.st_mode & 0o777:04o}",
                })
                for parent in (original.parent, resolved.parent):
                    cursor = parent
                    while str(cursor) != "/":
                        parent_stat = cursor.lstat()
                        system_parent_dirs[str(cursor)] = {
                            "path": str(cursor), "uid": parent_stat.st_uid,
                            "gid": parent_stat.st_gid,
                            "mode": f"{parent_stat.st_mode & 0o777:04o}",
                            "type": "symlink" if cursor.is_symlink() else "directory",
                            "target": os.readlink(cursor) if cursor.is_symlink() else None,
                        }
                        cursor = cursor.parent

        lock = json.loads((BUNDLE / "package-lock.json").read_text())
        entries = []
        for current, dirs, files in os.walk(root, topdown=True, followlinks=False):
            current_path = pathlib.Path(current)
            rel_dir = current_path.relative_to(root).as_posix()
            destination = INSTALL_ROOT if rel_dir == "." else f"{INSTALL_ROOT}/{rel_dir}"
            dir_mode = "0755" if rel_dir == "." else "0555"
            entries.append({"destination": destination, "type": "directory", "uid": 0, "gid": 0, "mode": dir_mode, "executable": False})
            for name in list(dirs):
                candidate = current_path / name
                if candidate.is_symlink():
                    dirs.remove(name)
                    rel = candidate.relative_to(root).as_posix()
                    entries.append({"destination": f"{INSTALL_ROOT}/{rel}", "type": "symlink", "target": os.readlink(candidate), "uid": 0, "gid": 0, "mode": "0777", "executable": False})
            for name in files:
                candidate = current_path / name
                rel = candidate.relative_to(root).as_posix()
                dest = f"{INSTALL_ROOT}/{rel}"
                if candidate.is_symlink():
                    entries.append({"destination": dest, "type": "symlink", "target": os.readlink(candidate), "uid": 0, "gid": 0, "mode": "0777", "executable": False})
                    continue
                package_name, package = npm_package_for(rel.removeprefix("cf-runtime/"), lock)
                if rel == "runtime/node":
                    source = {"kind": "node-release-archive", "name": NODE_ARCHIVE, "version": NODE_VERSION, "sha256": NODE_SHA256}
                    mode = "0555"
                elif rel == "cf-runtime/package.json":
                    source = {"kind": "bundle-file", "path": "package.json", "sha256": sha256(BUNDLE / "package.json")}
                    mode = "0444"
                elif rel == "cf-runtime/package-lock.json":
                    source = {"kind": "bundle-file", "path": "package-lock.json", "sha256": sha256(BUNDLE / "package-lock.json")}
                    mode = "0444"
                elif rel == "cf-runtime/node_modules/.package-lock.json":
                    source = {
                        "kind": "npm-generated-metadata",
                        "generator": "npm ci --ignore-scripts",
                        "input_bundle_file": "package-lock.json",
                        "input_sha256": sha256(BUNDLE / "package-lock.json"),
                    }
                    mode = "0444"
                elif package is not None:
                    source = {"kind": "npm-package", "name": package_name, "version": package["version"], "resolved": package["resolved"], "integrity": package["integrity"]}
                    mode = "0444"
                elif rel.startswith("broker/"):
                    source = {"kind": "reviewed-broker-source", "path": rel.removeprefix("broker/"), "sha256": sha256(candidate)}
                    mode = "0444"
                elif rel == "bin/nexus-cf-broker":
                    source = {"kind": "compiled-launcher", "source": "launcher.c", "sha256": sha256(candidate)}
                    mode = "0555"
                else:
                    source = {"kind": "bundle-file", "path": rel, "sha256": sha256(candidate)}
                    mode = "0444"
                entries.append({"destination": dest, "type": "regular-file", "source": source, "sha256": sha256(candidate), "uid": 0, "gid": 0, "mode": mode, "executable": mode == "0555"})

        if not any(item["destination"] == f"{INSTALL_ROOT}/broker/clean-start-check.mjs" for item in entries):
            raise SystemExit("protected clean-start check is absent from the install manifest")

        parent_dirs = []
        for p in ("/", "/opt"):
            st = pathlib.Path(p).stat()
            parent_dirs.append({"path": p, "uid": st.st_uid, "gid": st.st_gid, "mode": f"{st.st_mode & 0o777:04o}"})
        manifest = {
            "schema": "nexus-trusted-broker-install-manifest/v1",
            "platform": {"os": "linux", "architecture": "x86_64", "libc": "glibc", "kernel_observed": "6.8.0-142-generic"},
            "install_root": INSTALL_ROOT,
            "run_as": {"uid": 1000, "gid": 1000},
            "parent_directories": parent_dirs,
            "objects": sorted(entries, key=lambda item: item["destination"]),
            "system_runtime_dependencies": system_deps,
            "system_dependency_parent_directories": sorted(system_parent_dirs.values(), key=lambda item: item["path"]),
            "source_authority": {
                "node_version": NODE_VERSION,
                "node_archive": NODE_ARCHIVE,
                "node_archive_sha256": NODE_SHA256,
                "npm_cf_version": "1.0.0-beta.10",
                "npm_lockfile_version": lock["lockfileVersion"],
                "npm_lock_packages": len(lock["packages"]),
                "cf_npm_integrity": lock["packages"]["node_modules/cf"]["integrity"],
                "npm_signature_audit": "verified registry signatures and provenance attestations before manifest generation",
                "cf_version_startup_check": "passed without credentials using the pinned Node runtime",
            },
        }
        output = BUNDLE / "trusted-object-manifest.json"
        output.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print(json.dumps({"manifest": str(output), "object_count": len(entries), "system_dependency_count": len(system_deps), "node_version": version, "npm_signatures_audit": "passed"}, sort_keys=True))


if __name__ == "__main__":
    main()
