#!/usr/bin/env python3
"""Measure RC11 cancel-ack render-output latency over a synthetic loopback gateway."""
import datetime
import os
import select
import signal
import subprocess
import sys
import time
from pathlib import Path

from ptylib import Session, start_gw, tui_argv

FRAME_BUDGET_MS = 1000 / 60
TRIALS = 3


def read_until(session, predicate, deadline):
    while time.monotonic() < deadline:
        remaining = deadline - time.monotonic()
        ready, _, _ = select.select([session.fd], [], [], min(0.001, remaining))
        if not ready:
            continue
        try:
            chunk = os.read(session.fd, 65536)
        except OSError:
            return None
        if not chunk:
            return None
        session.raw += chunk
        session.log.write(chunk)
        session.log.flush()
        try:
            session.stream.feed(chunk)
        except Exception:
            pass
        query_count = session.raw.count(b"\x1b[c")
        while session.answered < query_count:
            os.write(session.fd, b"\x1b[?62c")
            session.answered += 1
        screen = session.text()
        if predicate(screen):
            return time.monotonic_ns(), screen
    return None


def trial(i):
    tag = f"s5_ack_{i}"
    gw, endpoint, _ = start_gw("slowstream", tag)
    env, ws, _ = __import__("ptylib").make_env(tag, endpoint)
    session = Session(tui_argv(ws, endpoint), env, 100, 30, ws, tag)
    try:
        assert session.wait("enter send", 15, "initial idle"), "TUI did not become idle"
        session.send(b"talk slowly\r", settle=0.1)
        assert session.wait("Thinking about it.", 10, "streaming response"), "no streamed response observed"
        session.pump(0.4)
        assert "Thinking about it." in session.text(), "stream ended before cancellation"
        started_wall = datetime.datetime.now(datetime.timezone.utc).isoformat()
        sent_ns = time.monotonic_ns()
        os.write(session.fd, b"\x03")
        ack = read_until(session, lambda s: "cancelling" in s.casefold(), time.monotonic() + 2)
        if ack is None:
            print(f"TRIAL {i} ACK=NOT_OBSERVED started={started_wall}", flush=True)
            return False
        ack_ns, ack_screen = ack
        latency_ms = (ack_ns - sent_ns) / 1_000_000
        ack_ok = latency_ms <= FRAME_BUDGET_MS
        print(f"TRIAL {i} started={started_wall} cancel_write_monotonic_ns={sent_ns} ack_output_observed_monotonic_ns={ack_ns} latency_ms={latency_ms:.3f} frame_budget_ms={FRAME_BUDGET_MS:.3f} ack_within_one_frame={ack_ok}", flush=True)
        print("ACK_SCREEN=" + " | ".join(x.strip() for x in ack_screen.splitlines() if "cancel" in x.casefold()), flush=True)
        idle = read_until(session, lambda s: "cancelled" in s.casefold() and "enter send" in s.casefold(), time.monotonic() + 5)
        if idle is None:
            print(f"TRIAL {i} IDLE_WITHIN_5S=NO", flush=True)
            return False
        idle_ns, _ = idle
        print(f"TRIAL {i} idle_latency_ms={(idle_ns - sent_ns) / 1_000_000:.3f} IDLE_WITHIN_5S=YES", flush=True)
        return ack_ok
    finally:
        session.close()
        gw.terminate()
        try:
            gw.wait(timeout=2)
        except subprocess.TimeoutExpired:
            gw.send_signal(signal.SIGTERM)
            gw.wait(timeout=2)


if __name__ == "__main__":
    passed = sum(bool(trial(i)) for i in range(1, TRIALS + 1))
    print(f"RESULT={passed}/{TRIALS} trials met one-frame ack plus idle <=5s", flush=True)
    sys.exit(0 if passed == TRIALS else 1)
