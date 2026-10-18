#!/usr/bin/python3
"""Unprivileged post-install gates. Emits status only; never prints cf output."""
from __future__ import annotations

import hashlib
import json
import os
import pathlib
import stat
import subprocess
import sys
import tempfile


ROOT = pathlib.Path("/opt/nexus-cloudflare-broker")
BUNDLE_ROOT = pathlib.Path(__file__).resolve(strict=True).parent
MANIFEST = ROOT / "share" / "trusted-object-manifest.json"
LAUNCHER = ROOT / "bin" / "nexus-cf-broker"
NODE = ROOT / "runtime" / "node"
CF_VERSION = "1.0.0-beta.10"
EXPECTED_MANIFEST_SHA256 = "b55ae32adce161f23176acbe1a8a048dd1165a076c95756823cc90e6d892df5a"


def digest(path: pathlib.Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def mode(info: os.stat_result) -> str:
    return f"{stat.S_IMODE(info.st_mode):04o}"


def immutable_probe(path: pathlib.Path, kind: str) -> bool:
    if kind == "regular-file":
        try:
            descriptor = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CLOEXEC | os.O_NOFOLLOW)
        except PermissionError:
            return True
        except OSError as error:
            return error.errno in (1, 13, 30)
        else:
            os.close(descriptor)
            return False
    if kind == "directory":
        probe = path / ".nexus-broker-mutability-probe"
        try:
            descriptor = os.open(probe, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
        except PermissionError:
            return True
        except OSError as error:
            return error.errno in (1, 13, 30)
        else:
            os.close(descriptor)
            probe.unlink(missing_ok=True)
            return False
    return True


def main() -> int:
    if os.geteuid() == 0:
        print(json.dumps({"passed": False, "reason": "must run as normal Nexus user"}))
        return 1
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    checks: dict[str, bool] = {}
    objects_ok = True
    writable_denied = True
    for item in manifest["objects"]:
        destination = pathlib.Path(item["destination"])
        try:
            info = destination.lstat()
        except OSError:
            objects_ok = False
            writable_denied = False
            continue
        kind = item["type"]
        observed_kind = "symlink" if stat.S_ISLNK(info.st_mode) else "directory" if stat.S_ISDIR(info.st_mode) else "regular-file" if stat.S_ISREG(info.st_mode) else "other"
        if observed_kind != kind or info.st_uid != item["uid"] or info.st_gid != item["gid"] or mode(info) != item["mode"]:
            objects_ok = False
        if kind == "regular-file" and digest(destination) != item["sha256"]:
            objects_ok = False
        if kind == "symlink" and os.readlink(destination) != item["target"]:
            objects_ok = False
        if kind in ("regular-file", "directory") and not immutable_probe(destination, kind):
            writable_denied = False
    manifest_digest = hashlib.sha256(MANIFEST.read_bytes()).hexdigest()
    if manifest_digest != EXPECTED_MANIFEST_SHA256:
        objects_ok = False
    try:
        manifest_info = MANIFEST.lstat()
        if not stat.S_ISREG(manifest_info.st_mode) or manifest_info.st_uid != 0 or manifest_info.st_gid != 0 or mode(manifest_info) != "0444":
            objects_ok = False
        if not immutable_probe(MANIFEST, "regular-file"):
            writable_denied = False
    except OSError:
        objects_ok = False
        writable_denied = False
    expected_paths = {str(pathlib.Path(item["destination"])) for item in manifest["objects"]}
    expected_paths.add(str(MANIFEST))
    actual_paths = {str(ROOT)}
    for current, dirs, files in os.walk(ROOT, topdown=True, followlinks=False):
        base = pathlib.Path(current)
        for name in list(dirs):
            candidate = base / name
            actual_paths.add(str(candidate))
            if candidate.is_symlink():
                dirs.remove(name)
        for name in files:
            actual_paths.add(str(base / name))
    if actual_paths != expected_paths:
        objects_ok = False
    for item in manifest["parent_directories"]:
        path = pathlib.Path(item["path"])
        try:
            info = path.lstat()
            if info.st_uid != item["uid"] or info.st_gid != item["gid"] or mode(info) != item["mode"]:
                objects_ok = False
            if not immutable_probe(path, "directory"):
                writable_denied = False
        except OSError:
            objects_ok = False
            writable_denied = False
    for item in manifest["system_runtime_dependencies"]:
        path = pathlib.Path(item["path"])
        try:
            resolved = pathlib.Path(item["resolved_path"])
            entry = path.lstat()
            actual_symlink = stat.S_ISLNK(entry.st_mode)
            if actual_symlink != item["path_is_symlink"]:
                objects_ok = False
            if actual_symlink and os.readlink(path) != item["symlink_target"]:
                objects_ok = False
            if entry.st_uid != item["entry_uid"] or entry.st_gid != item["entry_gid"] or mode(entry) != item["entry_mode"]:
                objects_ok = False
            info = resolved.stat()
            if info.st_uid != item["uid"] or info.st_gid != item["gid"] or mode(info) != item["mode"] or digest(resolved) != item["sha256"]:
                objects_ok = False
            if not immutable_probe(resolved, "regular-file"):
                writable_denied = False
        except OSError:
            objects_ok = False
            writable_denied = False
    for item in manifest["system_dependency_parent_directories"]:
        path = pathlib.Path(item["path"])
        try:
            info = path.lstat()
            observed = "symlink" if stat.S_ISLNK(info.st_mode) else "directory" if stat.S_ISDIR(info.st_mode) else "other"
            if observed != item["type"] or info.st_uid != item["uid"] or info.st_gid != item["gid"] or mode(info) != item["mode"]:
                objects_ok = False
            if observed == "symlink" and os.readlink(path) != item["target"]:
                objects_ok = False
            if observed == "directory" and not immutable_probe(path, "directory"):
                writable_denied = False
        except OSError:
            objects_ok = False
            writable_denied = False
    checks["manifest_and_runtime_identity"] = objects_ok and len(manifest_digest) == 64
    checks["normal_user_cannot_mutate_trusted_objects_or_parents"] = writable_denied
    checks["qualifier_runs_as_fixed_nexus_user"] = os.getuid() == 1000 and os.geteuid() == 1000
    if not all(checks.values()):
        print(json.dumps({"passed": False, "checks": checks}, sort_keys=True))
        return 1

    with tempfile.TemporaryDirectory(prefix="nexus-broker-hostile-") as temp:
        scratch = pathlib.Path(temp)
        shadow_bin = scratch / "shadow-bin"
        shadow_bin.mkdir()
        markers = [scratch / name for name in ("require", "import", "ld-preload")]
        path_marker = scratch / "path-shadow"
        preload = scratch / "preload.cjs"
        module = scratch / "import.mjs"
        preload.write_text(f"require('node:fs').writeFileSync({json.dumps(str(markers[0]))}, 'ran')\n", encoding="utf-8")
        # Separate files make each hostile loader surface directly inspectable.
        module.write_text(f"import fs from 'node:fs'; fs.writeFileSync({json.dumps(str(markers[1]))}, 'ran')\n", encoding="utf-8")
        so_source = scratch / "preload.c"
        so_file = scratch / "preload.so"
        so_source.write_text(
            "#include <stdlib.h>\n#include <fcntl.h>\n#include <unistd.h>\n"
            "__attribute__((constructor)) static void mark(void){const char*p=getenv(\"BROKER_LD_MARKER\");"
            "if(p){int f=open(p,O_WRONLY|O_CREAT|O_TRUNC,0600);if(f>=0){write(f,\"ran\",3);close(f);}}}\n",
            encoding="utf-8",
        )
        compiled = subprocess.run(["/usr/bin/cc", "-shared", "-fPIC", "-o", str(so_file), str(so_source)], capture_output=True, timeout=15)
        if compiled.returncode != 0:
            print(json.dumps({"passed": False, "checks": checks, "reason": "hostile preload fixture build failed"}, sort_keys=True))
            return 1
        for name in ("node", "cf"):
            substitute = shadow_bin / name
            substitute.write_text(f"#!/bin/sh\nprintf ran > {path_marker}\n", encoding="utf-8")
            substitute.chmod(0o700)
        (scratch / ".env").write_text(
            "CLOUDFLARE_API_TOKEN=synthetic-unusable-clean-start-canary\n"
            "CLOUDFLARE_API_BASE_URL=https://127.0.0.1/untrusted\n",
            encoding="utf-8",
        )
        hostile = {
            "HOME": str(scratch / "wrong-home"), "XDG_CONFIG_HOME": str(scratch / "wrong-xdg"),
            "PATH": str(shadow_bin),
            "NODE_OPTIONS": f"--require={preload} --import={module}", "NODE_PATH": str(scratch / "shadow-modules"),
            "LD_PRELOAD": str(so_file), "BROKER_LD_MARKER": str(markers[2]),
            "npm_config_userconfig": str(scratch / "hostile.npmrc"), "CF_BROKER_TEST_MARKER": str(scratch / "hostile-env-ran"),
            "DEBUG": "1", "CLOUDFLARE_API_BASE_URL": "https://127.0.0.1/attacker",
        }
        environment = subprocess.run([str(LAUNCHER), "clean-start-check"], cwd=scratch, env=hostile,
                                     capture_output=True, text=True, timeout=20)
        try:
            clean_start = json.loads(environment.stdout)
        except (ValueError, TypeError):
            clean_start = {}
        checks["trusted_runtime_observed_exact_clean_environment"] = (
            environment.returncode == 0 and clean_start == {
                "passed": True, "envIsExact": True, "cwdIsFixed": True, "noNodeArguments": True,
            }
        )
        version = subprocess.run([str(LAUNCHER), "version-check"], cwd=scratch, env=hostile,
                                 capture_output=True, text=True, timeout=20)
        no_preload = not any(path.exists() for path in markers) and not path_marker.exists() and not (scratch / "hostile-env-ran").exists()
        expected_version = version.returncode == 0 and CF_VERSION in version.stdout
        checks["hostile_startup_injection_did_not_run"] = no_preload
        checks["trusted_cf_version_entrypoint_executed"] = expected_version
        auth = subprocess.run([str(LAUNCHER), "auth-check"], cwd=scratch, env=hostile,
                              capture_output=True, text=True, timeout=45)
        checks["saved_cf_authentication_works_under_clean_start"] = auth.returncode == 0
        # The cf identity response is intentionally discarded; only status survives.
        auth.stdout = ""
        auth.stderr = ""

    if not all(checks.values()):
        print(json.dumps({"passed": False, "checks": checks}, sort_keys=True))
        return 1
    isolated_python = subprocess.run(
        ["/usr/bin/python3.12", "-I", "-S", str(BUNDLE_ROOT / "test-install-python-boundary.py")],
        cwd="/", env={"HOME": "/nonexistent", "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
        capture_output=True, text=True, timeout=15,
    )
    try:
        python_boundary_result = json.loads(isolated_python.stdout)
    except (ValueError, TypeError):
        python_boundary_result = {}
    checks["privileged_python_import_shadow_negative_control"] = (
        isolated_python.returncode == 0 and python_boundary_result.get("passed") is True
    )
    isolated_python.stdout = ""
    isolated_python.stderr = ""

    synthetic_results = []
    synthetic_outputs: dict[str, str] = {}
    for name in ("credential-probe-safe-test.mjs", "artifact-token-response-test.mjs", "linux-bound-exec-test.mjs", "credential-lifecycle-test.mjs", "demo-transport-test.mjs"):
        node = subprocess.run([str(NODE), "--test", str(BUNDLE_ROOT / "broker" / name)],
                              cwd="/", env={"HOME": "/nonexistent", "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
                              capture_output=True, text=True, timeout=90)
        passed = node.returncode == 0 and ("ℹ fail 0" in node.stdout or "# fail 0" in node.stdout)
        if name in ("credential-probe-safe-test.mjs", "linux-bound-exec-test.mjs"):
            passed = passed and '"cloudflareOperations":0' in node.stdout
        if name == "demo-transport-test.mjs":
            passed = passed and '"syntheticOnly":true,"cloudflareOperations":0,"passed":true' in node.stdout
        synthetic_outputs[name] = node.stdout
        synthetic_results.append(passed)
        node.stdout = ""
        node.stderr = ""
    checks["synthetic_broker_suite_passed"] = all(synthetic_results)
    checks["synthetic_suites_used_fake_cloudflare_commands_only"] = all(synthetic_results)
    checks["demo_transport_synthetic_suite_passed"] = '"syntheticOnly":true,"cloudflareOperations":0,"passed":true' in synthetic_outputs.get("demo-transport-test.mjs", "")

    if checks["manifest_and_runtime_identity"] and checks["normal_user_cannot_mutate_trusted_objects_or_parents"] and checks["qualifier_runs_as_fixed_nexus_user"]:
        readiness = subprocess.run(
            ["/usr/bin/sudo", "-n", str(LAUNCHER), "demo-transport"],
            cwd="/", env={"HOME": "/nonexistent", "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
            input=b'{"operation":"capability-status"}\n', capture_output=True, timeout=15,
        )
        try:
            readiness_result = json.loads(readiness.stdout)
        except (ValueError, TypeError):
            readiness_result = {}
        readiness_ok = readiness.returncode == 0 and readiness_result == {
            "ok": True, "operation": "capability-status",
            "artifactsGitCredential": "CUSTODY_VALID", "workerBearer": "CUSTODY_VALID",
        } and not readiness.stderr
        checks["sudo_demo_transport_capability_readiness"] = readiness_ok
        checks["protected_capability_status_reports_valid_custody"] = readiness_ok
        direct = subprocess.run(
            [str(LAUNCHER), "demo-transport"],
            cwd="/", env={"HOME": "/nonexistent", "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "SUDO_UID": "1000"},
            input=b'{"operation":"capability-status"}\n', capture_output=True, timeout=15,
        )
        checks["direct_unprivileged_launcher_rejected_even_with_forged_sudo_uid"] = (
            direct.returncode == 126 and not direct.stdout and direct.stderr == b"nexus-cf-broker: demo transport requires sudo from the fixed Nexus user\n"
        )
        direct.stdout = b""
        direct.stderr = b""
    else:
        checks["sudo_demo_transport_capability_readiness"] = False
        checks["protected_capability_status_reports_valid_custody"] = False
        checks["direct_unprivileged_launcher_rejected_even_with_forged_sudo_uid"] = False

    if checks["sudo_demo_transport_capability_readiness"]:
        malformed = subprocess.run(
            ["/usr/bin/sudo", "-n", str(LAUNCHER), "demo-transport"],
            cwd="/", env={"HOME": "/nonexistent", "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
            input=b'{', capture_output=True, timeout=15,
        )
        unsupported = subprocess.run(
            ["/usr/bin/sudo", "-n", str(LAUNCHER), "demo-transport"],
            cwd="/", env={"HOME": "/nonexistent", "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
            input=b'{"operation":"arbitrary-command"}\n', capture_output=True, timeout=15,
        )
        checks["malformed_transport_request_rejected"] = (
            malformed.returncode == 1 and malformed.stdout == b'{"ok":false,"error":"INVALID_REQUEST"}\n' and not malformed.stderr
        )
        checks["unsupported_transport_operation_rejected"] = (
            unsupported.returncode == 1 and unsupported.stdout == b'{"ok":false,"error":"INVALID_REQUEST"}\n' and not unsupported.stderr
        )
        malformed.stdout = b""
        malformed.stderr = b""
        unsupported.stdout = b""
        unsupported.stderr = b""
        absent_ref = subprocess.run(
            ["/usr/bin/sudo", "-n", str(LAUNCHER), "demo-transport"],
            cwd="/", env={"HOME": "/nonexistent", "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
            input=b'{"operation":"repo-ref","runId":"00000000-0000-4000-8000-000000000001","role":"work-state"}\n', capture_output=True, timeout=30,
        )
        worker_missing_state = subprocess.run(
            ["/usr/bin/sudo", "-n", str(LAUNCHER), "demo-transport"],
            cwd="/", env={"HOME": "/nonexistent", "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
            input=b'{"operation":"worker-work-state","runId":"00000000-0000-4000-8000-000000000001","expectedCommitSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","expectedContentDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}\n',
            capture_output=True, timeout=20,
        )
        try:
            ref_result = json.loads(absent_ref.stdout)
            worker_result = json.loads(worker_missing_state.stdout)
        except (ValueError, TypeError):
            ref_result = worker_result = {}
        checks["protected_artifacts_read_confirms_fixture_ref_absent"] = (
            absent_ref.returncode == 1 and ref_result == {"ok": False, "error": "REF_NOT_FOUND"} and not absent_ref.stderr
        )
        checks["protected_worker_distinguishes_missing_state"] = (
            worker_missing_state.returncode == 1 and worker_result == {"ok": False, "error": "WORK_STATE_NOT_FOUND"} and not worker_missing_state.stderr
        )
        absent_ref.stdout = b""
        absent_ref.stderr = b""
        worker_missing_state.stdout = b""
        worker_missing_state.stderr = b""
    else:
        checks["protected_artifacts_read_confirms_fixture_ref_absent"] = False
        checks["protected_worker_distinguishes_missing_state"] = False
        checks["malformed_transport_request_rejected"] = False
        checks["unsupported_transport_operation_rejected"] = False
    print(json.dumps({"passed": all(checks.values()), "checks": checks}, sort_keys=True))
    return 0 if all(checks.values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
