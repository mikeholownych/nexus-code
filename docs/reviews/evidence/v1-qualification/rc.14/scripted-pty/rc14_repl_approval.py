import json
import os
import re
import time

from ptylib import Session, gw_log, make_env, start_gw


NEXUS_HOME = os.environ["NEXUS_PTY_HOME"]
INDEX = os.environ["NEXUS_PTY_INDEX"]
PROMPT = "Approve [y]es, [n]o, [d]iff preview, [a]lways allow session? [y/N/d/a]:"
DENIAL = re.compile(r"(?:cancelled by user|denied by user|action denied|tool denied|execution was rejected by the user)", re.IGNORECASE)
RUN_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "runs")


def run_case(tag: str, typed_ahead: bool) -> dict[str, object]:
    gateway, endpoint, request_log = start_gw("write", tag)
    env, workspace, home = make_env(tag, endpoint)
    env["NEXUS_HOME"] = NEXUS_HOME
    env["NEXUS_PTY_HOME"] = NEXUS_HOME
    env["NEXUS_PTY_TUI"] = os.environ["NEXUS_PTY_TUI"]
    env["NEXUS_PTY_SIDECAR"] = os.environ["NEXUS_PTY_SIDECAR"]
    env["NEXUS_PTY_INDEX"] = INDEX
    env["PATH"] = os.environ["PATH"]
    argv = ["node", INDEX, "--repl", "--approve", "-w", workspace, "-e", endpoint, "-m", "m"]
    session = Session(argv, env, 100, 30, workspace, tag)
    result: dict[str, object] = {"scenario": tag, "typedAheadY": typed_ahead}
    try:
        result["initialPrompt"] = session.wait("❯", 20, "repl-prompt")
        if not result["initialPrompt"]:
            result["verdict"] = "INVALID_LAUNCH"
            return result
        session.send(b"create hello.txt\r", settle=0.25, label="request write approval")
        if typed_ahead:
            time.sleep(0.25)
            session.send(b"y", settle=0.05, label="typed-ahead y before approval prompt")
        result["approvalPrompt"] = session.wait(PROMPT, 15, "RC14-approval-prompt")
        if not result["approvalPrompt"]:
            result["verdict"] = "INVALID_PROMPT"
            return result
        session.dump("approval-prompt")
        if typed_ahead:
            session.pump(0.65)
            result["typedAheadDiscarded"] = "typed-ahead input discarded" in session.text().lower()
        else:
            # The first 400ms after the prompt are deliberately protected; wait
            # past that grace interval so this case exercises a deliberate blank Enter.
            session.pump(0.65)
        session.send(b"\r", label="Enter with no explicit y after grace window")
        gateway_deadline = time.monotonic() + 10
        while time.monotonic() < gateway_deadline:
            if len(gw_log(request_log)) >= 2:
                break
            session.pump(0.2)
        session.dump("after-denial")
        result["fileExists"] = os.path.exists(os.path.join(workspace, "hello.txt"))
        gateway_records = gw_log(request_log)
        result["gatewayRequests"] = len(gateway_records)
        result["gatewayRejected"] = len(gateway_records) == 2 and "execution was rejected by the user" in gateway_records[-1].get("last", "").lower()
        result["homeIsolated"] = os.path.commonpath([home, RUN_ROOT]) == RUN_ROOT
        result["verdict"] = "PASS" if result["initialPrompt"] and result["approvalPrompt"] and result["gatewayRejected"] and not result["fileExists"] and result["homeIsolated"] and (not typed_ahead or result["typedAheadDiscarded"]) else "FAIL"
    finally:
        session.close()
        gateway.terminate()
        gateway.wait(timeout=5)
    return result


results = [run_case("r1a", False), run_case("r1d", True)]
with open("rc14-repl-approval-status.json", "x", encoding="utf-8") as stream:
    json.dump({"acceptance": "ACCEPTANCE §5.2", "artifact": os.environ["NEXUS_PTY_ARTIFACT"], "results": results}, stream, indent=2)
print(json.dumps([{key: value for key, value in result.items() if key != "gatewayRequests"} for result in results], sort_keys=True))
if any(result["verdict"] != "PASS" for result in results):
    raise SystemExit(1)
