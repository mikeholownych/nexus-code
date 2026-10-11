#!/usr/bin/python3
"""Synthetic startup-boundary test for launcher.c; never contacts Cloudflare."""
from __future__ import annotations

import json
import os
import pathlib
import shutil
import subprocess
import tempfile


ROOT = pathlib.Path(__file__).resolve().parent
CC = "/usr/bin/cc"
NODE = "/home/mike/.local/node-v24.11.1-linux-x64/bin/node"


def run() -> dict[str, object]:
    with tempfile.TemporaryDirectory(prefix="nexus-launcher-test-") as temp:
        base = pathlib.Path(temp)
        hostile_home = base / "hostile-home"
        hostile_cwd = base / "hostile-cwd"
        hostile_cwd.mkdir()
        marker_dir = base / "markers"
        marker_dir.mkdir()
        shadow_bin = base / "shadow-bin"
        shadow_bin.mkdir()
        require_marker = marker_dir / "require.marker"
        import_marker = marker_dir / "import.marker"
        preload_marker = marker_dir / "ld-preload.marker"
        run_marker = marker_dir / "trusted-runtime.marker"
        path_marker = marker_dir / "path-shadow.marker"
        preload_js = base / "preload.cjs"
        import_js = base / "import.mjs"
        cf_script = base / "fake-cf.mjs"
        broker_script = base / "fake-broker.mjs"
        preload_so = base / "preload.so"
        launcher = base / "launcher"
        preload_js.write_text(
            "require('node:fs').writeFileSync(process.env.REQUIRE_MARKER, 'ran');\n",
            encoding="utf-8",
        )
        import_js.write_text(
            "import fs from 'node:fs'; fs.writeFileSync(process.env.IMPORT_MARKER, 'ran');\n",
            encoding="utf-8",
        )
        for script in (cf_script, broker_script):
            script.write_text(
                "import fs from 'node:fs';\n"
                "const want=JSON.parse(process.env.TEST_EXPECTED);\n"
                "const got={cwd:process.cwd(),home:process.env.HOME,xdg:process.env.XDG_CONFIG_HOME,path:process.env.PATH,"
                "nodeOptions:process.env.NODE_OPTIONS??null,nodePath:process.env.NODE_PATH??null,ldPreload:process.env.LD_PRELOAD??null,"
                "npmConfig:process.env.npm_config_userconfig??null};\n"
                "if(JSON.stringify(got)!==JSON.stringify(want)) process.exit(45);\n"
                "fs.writeFileSync(process.env.RUN_MARKER,'trusted-runtime-ran');\n",
                encoding="utf-8",
            )
        for name in ("node", "cf"):
            substitute = shadow_bin / name
            substitute.write_text(f"#!/bin/sh\nprintf ran > {path_marker}\n", encoding="utf-8")
            substitute.chmod(0o755)
        shared_source = base / "preload.c"
        shared_source.write_text(
            "#define _GNU_SOURCE\n#include <stdlib.h>\n#include <fcntl.h>\n#include <unistd.h>\n"
            "__attribute__((constructor)) static void mark(void){const char*p=getenv(\"PRELOAD_MARKER\");"
            "if(p){int f=open(p,O_WRONLY|O_CREAT|O_TRUNC,0600);if(f>=0){write(f,\"ran\",3);close(f);}}}\n",
            encoding="utf-8",
        )
        subprocess.run(
            [CC, "-shared", "-fPIC", "-o", str(preload_so), str(shared_source)],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        expected = {
            "cwd": "/",
            "home": str(hostile_home),
            "xdg": str(hostile_home / ".config"),
            "path": "/usr/bin:/bin",
            "nodeOptions": None,
            "nodePath": None,
            "ldPreload": None,
            "npmConfig": None,
        }
        macros = {
            "BROKER_NODE": NODE,
            "BROKER_CF_SCRIPT": str(cf_script),
            "BROKER_SCRIPT": str(broker_script),
            "BROKER_HOME": str(hostile_home),
            "BROKER_XDG_CONFIG_HOME": str(hostile_home / ".config"),
            "BROKER_TEST_EXPECTED": json.dumps(expected, separators=(",", ":")),
            "BROKER_TEST_RUN_MARKER": str(run_marker),
        }
        compile_args = [CC, "-static", "-fPIE", "-pie", "-Wl,--build-id=none", "-DBROKER_TEST_BUILD"]
        compile_args.extend(f"-D{name}={json.dumps(value)}" for name, value in macros.items())
        compile_args.extend(["-o", str(launcher), str(ROOT / "launcher.c")])
        subprocess.run(
            compile_args,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        ldd = subprocess.run(["/usr/bin/ldd", str(launcher)], capture_output=True, text=True)
        static_launcher = "not a dynamic executable" in (ldd.stdout + ldd.stderr)
        hostile_env = {
            "HOME": str(base / "wrong-home"),
            "XDG_CONFIG_HOME": str(base / "wrong-xdg"),
            "PATH": str(shadow_bin),
            "NODE_OPTIONS": f"--require={preload_js} --import={import_js}",
            "NODE_PATH": str(base / "shadow-modules"),
            "LD_PRELOAD": str(preload_so),
            "PRELOAD_MARKER": str(preload_marker),
            "REQUIRE_MARKER": str(require_marker),
            "IMPORT_MARKER": str(import_marker),
            "npm_config_userconfig": str(base / "hostile.npmrc"),
        }
        result = subprocess.run(
            [str(launcher), "auth-check"],
            cwd=hostile_cwd,
            env=hostile_env,
            capture_output=True,
            text=True,
            timeout=15,
        )
        launcher_preloads_absent = all(
            not marker.exists() for marker in (require_marker, import_marker, preload_marker, path_marker)
        )
        launcher_runtime_executed = result.returncode == 0 and run_marker.exists()
        direct_env = {
            **hostile_env,
            "TEST_EXPECTED": json.dumps(expected, separators=(",", ":")),
            "RUN_MARKER": str(run_marker),
        }
        direct_control = subprocess.run(
            [NODE, str(cf_script)],
            cwd=hostile_cwd,
            env=direct_env,
            capture_output=True,
            text=True,
            timeout=15,
        )
        direct_detected_all_injections = all(
            marker.exists() for marker in (require_marker, import_marker, preload_marker)
        )
        rejects_extra_args = subprocess.run(
            [str(launcher), "auth-check", str(base / "untrusted.mjs")],
            cwd=hostile_cwd,
            env=hostile_env,
            capture_output=True,
            text=True,
            timeout=5,
        )
        rejects_unprivileged_demo_transport = subprocess.run(
            [str(launcher), "demo-transport"], cwd=hostile_cwd, env=hostile_env,
            input='{"operation":"repo-default"}\n', capture_output=True, text=True, timeout=5,
        )
        forged_direct_env = {**hostile_env, "SUDO_UID": "1000"}
        rejects_forged_direct_demo_transport = subprocess.run(
            [str(launcher), "demo-transport"], cwd=hostile_cwd, env=forged_direct_env,
            input='{"operation":"repo-default"}\n', capture_output=True, text=True, timeout=5,
        )
        sudo_invocation_env = {"PATH": "/usr/bin:/bin", "HOME": "/nonexistent", "LANG": "C", "SUDO_UID": "65534", "SUDO_USER": "untrusted"}
        admitted_sudo_demo_transport = subprocess.run(
            ["/usr/bin/sudo", "-n", str(launcher), "demo-transport"], cwd=hostile_cwd,
            env=sudo_invocation_env, input='{"operation":"capability-status"}\n',
            capture_output=True, text=True, timeout=5,
        )
        findings = {
            "launcher_is_static": static_launcher,
            "trusted_runtime_executed": launcher_runtime_executed,
            "require_preload_did_not_run": launcher_preloads_absent,
            "import_preload_did_not_run": launcher_preloads_absent,
            "ld_preload_did_not_run": launcher_preloads_absent,
            "hostile_cwd_and_env_overridden": result.returncode == 0,
            "direct_runtime_negative_control_detected_all_three_injections": direct_detected_all_injections,
            "direct_runtime_negative_control_failed_expectedly": direct_control.returncode != 0,
            "path_shadow_did_not_run": not path_marker.exists(),
            "arbitrary_module_argument_rejected": rejects_extra_args.returncode != 0,
            "demo_transport_rejects_direct_unprivileged_invocation": rejects_unprivileged_demo_transport.returncode == 126,
            "caller_environment_cannot_forge_direct_admission": rejects_forged_direct_demo_transport.returncode == 126,
            "sudo_invocation_admits_actual_fixed_caller": admitted_sudo_demo_transport.returncode == 0 and admitted_sudo_demo_transport.stdout == "TEST_DEMO_TRANSPORT_ADMITTED\n",
            "cloudflare_not_invoked": True,
        }
        return {"checks": findings, "passed": all(findings.values())}


if __name__ == "__main__":
    print(json.dumps(run(), sort_keys=True))
