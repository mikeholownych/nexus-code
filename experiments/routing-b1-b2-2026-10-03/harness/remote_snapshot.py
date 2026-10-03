import json, hashlib, os, subprocess, glob
def sh(c): return subprocess.run(c, shell=True, capture_output=True, text=True).stdout.strip()
def fh(p): return hashlib.sha256(open(p, "rb").read()).hexdigest()
rel = "/var/lib/aihost/releases/t5820-gateway-2d75d4c"
out = {"gateway": {}, "workers": {}, "host": {}}
out["gateway"]["release_dir"] = rel
out["gateway"]["files"] = {os.path.relpath(os.path.join(r, x), rel): fh(os.path.join(r, x)) for r, d, fs in os.walk(rel) if "__pycache__" not in r for x in sorted(fs)}
out["gateway"]["unit_sha256"] = fh("/etc/systemd/system/aihost-orchestrator-gateway.service")
env = open("/etc/local-ai/orchestrator/gateway.env").read(); out["gateway"]["env_sha256"] = hashlib.sha256(env.encode()).hexdigest()
nonsecret = {}
for line in env.splitlines():
    k, _, v = line.partition("=")
    if k in ("ORCHESTRATOR_ROUTES", "ORCHESTRATOR_MODEL_ALIASES", "ORCHESTRATOR_SCHEDULING_MODE", "ORCHESTRATOR_ALLOW_WORKER_PINNING", "ORCHESTRATOR_PUBLIC_MODEL_ID"): nonsecret[k] = v
    if k == "ORCHESTRATOR_WORKER_SPECS": nonsecret["worker_specs"] = [{kk: s[kk] for kk in ("worker_id", "pool", "engine", "model_id", "revision", "artifact_digest", "runtime_image_digest", "context_limit", "max_output_tokens", "max_concurrency", "endpoint")} for s in json.loads(v)]
out["gateway"]["config"] = nonsecret
pid = sh("systemctl show aihost-orchestrator-gateway -p MainPID --value"); out["gateway"]["main_pid"] = pid
out["gateway"]["active_since"] = sh("systemctl show aihost-orchestrator-gateway -p ActiveEnterTimestamp --value")
out["gateway"]["proc_cwd"] = os.readlink(f"/proc/{pid}/cwd")
for n in ("1", "2"):
    u = f"aihost-llama-worker{n}"
    out["workers"][u] = {"unit_sha256": fh(f"/etc/systemd/system/{u}.service"), "active_since": sh(f"systemctl show {u} -p ActiveEnterTimestamp --value"), "main_pid": sh(f"systemctl show {u} -p MainPID --value"),
                         "exec_start": [l for l in open(f"/etc/systemd/system/{u}.service").read().splitlines() if "llama-server" in l or "--model" in l or "--ctx" in l or "-c " in l][:6],
                         "image": [l.strip() for l in open(f"/etc/systemd/system/{u}.service").read().splitlines() if "sha256:" in l][:1]}
for f in glob.glob("/var/lib/local-ai/models/gguf/*.gguf"):
    if any(k in f for k in ("Qwen3-Coder-30B-A3B-Instruct-Q4_K_M", "Qwen3.5-27B-Q4_K_M")): out["host"][os.path.basename(f)] = {"size": os.path.getsize(f), "mtime": int(os.path.getmtime(f))}
out["host"]["kernel"] = sh("uname -r"); out["host"]["boot_id"] = open("/proc/sys/kernel/random/boot_id").read().strip()
print(json.dumps(out, sort_keys=True))
