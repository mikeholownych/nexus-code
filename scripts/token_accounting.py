#!/usr/bin/env python3
"""Reconciles a saved Nexus session's tokenStats with the per-request inference receipts.

Usage: scripts/token_accounting.py RECEIPTS.jsonl SESSION.json [FROM_ISO TO_ISO]

RECEIPTS is the workspace's .nexus/inference_receipts.jsonl (one line per inference request, written by the client
with the provider's own usage report when it gives one). SESSION is a saved or exported session. Without a window,
the session's first and last request times are taken from the receipts' main-role requests between the session's
createdAt-30min and updatedAt. Prints a JSON report: request counts by outcome and usage confidence, the sums of
reported input/output tokens, their equality with the session's tokenStats, and per-request input percentiles.
"""
import hashlib
import json
import sys


def main():
    receipts_path, session_path = sys.argv[1], sys.argv[2]
    rows = [json.loads(line) for line in open(receipts_path) if line.strip()]
    session = json.load(open(session_path))
    start, end = (sys.argv[3], sys.argv[4]) if len(sys.argv) >= 5 else (None, None)
    window = [r for r in rows if (start is None or r["at"] >= start) and (end is None or r["at"] <= end)]
    completed = [r for r in window if r.get("outcome") == "completed" and r.get("usage")]
    inputs = sorted(r["usage"].get("inputTokens", 0) for r in completed)
    total_in = sum(inputs)
    total_out = sum(r["usage"].get("outputTokens", 0) for r in completed)
    cached = sum(r["usage"].get("cachedInputTokens", 0) for r in completed)
    stats = session.get("tokenStats") or {}
    pct = lambda p: inputs[min(len(inputs) - 1, int(p * len(inputs)))] if inputs else 0  # noqa: E731
    report = {
        "receipts_file_sha256": hashlib.sha256(open(receipts_path, "rb").read()).hexdigest(),
        "session_file_sha256": hashlib.sha256(open(session_path, "rb").read()).hexdigest(),
        "window": {"from": window[0]["at"] if window else None, "to": window[-1]["at"] if window else None},
        "requests": len(window),
        "by_outcome": {k: sum(1 for r in window if r.get("outcome") == k) for k in sorted({r.get("outcome") for r in window})},
        "by_usage_confidence": {k: sum(1 for r in window if r.get("usageConfidence") == k) for k in sorted({str(r.get("usageConfidence")) for r in window})},
        "distinct_request_ids": len({r["requestId"] for r in window}),
        "sum_reported_input_tokens": total_in,
        "sum_reported_output_tokens": total_out,
        "sum_cached_input_tokens": cached,
        "session_tokenStats": stats,
        "prompt_equals_sum_of_reported_input": stats.get("prompt") == total_in,
        "completion_equals_sum_of_reported_output": stats.get("completion") == total_out,
        "input_tokens_per_request": {"min": inputs[0] if inputs else 0, "p50": pct(0.5), "p90": pct(0.9), "max": inputs[-1] if inputs else 0},
    }
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
