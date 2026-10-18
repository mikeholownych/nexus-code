#!/usr/bin/env python3
"""Apply community settings using an explicitly authenticated GitHub CLI.

Default is a local plan. Does not modify protections, releases, or collaborators.
"""
import argparse
import json
from pathlib import Path
import subprocess
import sys

REPO = "mikeholownych/nexus-code"
ROOT = Path(__file__).resolve().parents[1]
DESCRIPTION = "Local coding agent with a terminal UI, Rust workspace tools, and local or cloud inference."
TOPICS = ["coding-agent", "terminal", "rust", "typescript", "local-ai", "developer-tools"]


def api(method, endpoint, body=None):
    command = ["gh", "api", "--hostname", "github.com", "--method", method, endpoint]
    payload = None
    if body is not None:
        command += ["--input", "-"]
        payload = json.dumps(body)
    result = subprocess.run(command, input=payload, text=True, capture_output=True)
    if result.returncode:
        # Do not dump arbitrary API response content or authentication diagnostics.
        raise RuntimeError(f"{method} {endpoint} failed (exit {result.returncode}); inspect permissions in GitHub")
    return json.loads(result.stdout) if result.stdout.strip() else None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Apply settings with the authenticated admin account")
    args = parser.parse_args()
    labels = json.loads((ROOT / ".github/labels.json").read_text())
    plan = {"repository": REPO, "description": DESCRIPTION, "topics": TOPICS,
            "enable": ["issues", "discussions", "private vulnerability reporting", "Dependabot alerts", "Dependabot security updates", "secret scanning", "secret push protection"],
            "labels": labels, "preserve": ["rulesets", "collaborators", "visibility", "release state", "existing unrelated labels"]}
    print(json.dumps(plan, indent=2))
    if not args.apply:
        return 0
    prefix = f"repos/{REPO}"
    before = api("GET", prefix)
    if not before.get("permissions", {}).get("admin"):
        raise RuntimeError("An authenticated repository administrator is required")
    api("PATCH", prefix, {"description": DESCRIPTION, "has_issues": True, "has_discussions": True})
    api("PUT", prefix + "/topics", {"names": sorted(set(before.get("topics", [])) | set(TOPICS))})
    failures = []
    operations = [("PUT", "/private-vulnerability-reporting", None),
                  ("PUT", "/vulnerability-alerts", None),
                  ("PUT", "/automated-security-fixes", None),
                  ("PATCH", "", {"security_and_analysis": {"secret_scanning": {"status": "enabled"},
                                      "secret_scanning_push_protection": {"status": "enabled"}}})]
    for method, suffix, body in operations:
        try:
            api(method, prefix + suffix, body)
            print(f"Applied {method} {suffix or '/repository'}")
        except RuntimeError as error:
            failures.append(str(error))
    existing = {}
    page = 1
    while True:
        batch = api("GET", prefix + f"/labels?per_page=100&page={page}")
        existing.update({item["name"].lower(): item for item in batch})
        if len(batch) < 100:
            break
        page += 1
    from urllib.parse import quote
    for label in labels:
        old = existing.get(label["name"].lower())
        if old:
            api("PATCH", prefix + "/labels/" + quote(old["name"], safe=""),
                {"new_name": label["name"], "color": label["color"], "description": label["description"]})
        else:
            api("POST", prefix + "/labels", label)
    after = api("GET", prefix)
    assert after["description"] == DESCRIPTION
    assert set(TOPICS).issubset(after.get("topics", []))
    private = api("GET", prefix + "/private-vulnerability-reporting")
    if not private.get("enabled"):
        failures.append("Private vulnerability reporting did not verify enabled")
    # A successful GET is the API's enabled signal for vulnerability alerts.
    try:
        api("GET", prefix + "/vulnerability-alerts")
    except RuntimeError as error:
        failures.append(str(error))
    print("Metadata verified. Inspect Security settings for feature availability and effective scanning coverage.")
    for failure in failures:
        print("UNRESOLVED: " + failure, file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, AssertionError) as error:
        print(str(error) or "Settings verification failed", file=sys.stderr)
        sys.exit(1)
