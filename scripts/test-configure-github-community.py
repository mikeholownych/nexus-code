#!/usr/bin/env python3
"""Offline regression checks for administration preview and effective-state readback."""
import contextlib
import importlib.util
import io
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "community", Path(__file__).with_name("configure-github-community.py"))
community = importlib.util.module_from_spec(spec)
spec.loader.exec_module(community)


class AdministrationChecks(unittest.TestCase):
    def run_helper(self, *, apply=True, overrides=None, admin=True):
        calls = []
        labels = community.json.loads((community.ROOT / ".github/labels.json").read_text())
        repo = {"permissions": {"admin": admin}, "description": community.DESCRIPTION,
                "topics": community.TOPICS, "has_issues": True, "has_discussions": True,
                "security_and_analysis": {
                    "secret_scanning": {"status": "enabled"},
                    "secret_scanning_push_protection": {"status": "enabled"}}}
        overrides = overrides or {}

        def api(method, endpoint, body=None):
            calls.append((method, endpoint, body))
            if method != "GET":
                return None
            suffix = endpoint.removeprefix("repos/" + community.REPO)
            if suffix in overrides:
                value = overrides[suffix]
                if isinstance(value, Exception):
                    raise value
                return value
            if suffix == "":
                return repo
            if suffix.startswith("/labels?"):
                return labels
            if suffix.startswith("/labels/"):
                from urllib.parse import unquote
                return next(label for label in labels if label["name"] == unquote(suffix[8:]))
            return {"/private-vulnerability-reporting": {"enabled": True},
                    "/automated-security-fixes": {"enabled": True, "paused": False},
                    "/vulnerability-alerts": None}[suffix]

        output = io.StringIO()
        with patch.object(community, "api", api), patch.object(sys, "argv", ["helper"] + (["--apply"] if apply else [])):
            with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
                result = community.main()
        return result, calls, output.getvalue(), repo

    def test_preview_never_calls_api(self):
        result, calls, _, _ = self.run_helper(apply=False)
        self.assertEqual(result, 0)
        self.assertEqual(calls, [])

    def test_non_admin_refuses_before_mutation(self):
        with self.assertRaisesRegex(RuntimeError, "administrator"):
            self.run_helper(admin=False)

    def test_success_requires_all_readbacks(self):
        result, calls, output, _ = self.run_helper()
        self.assertEqual(result, 0)
        reads = [endpoint for method, endpoint, _ in calls if method == "GET"]
        self.assertTrue(any(endpoint.endswith("/automated-security-fixes") for endpoint in reads))
        self.assertTrue(any("/labels/good%20first%20issue" in endpoint for endpoint in reads))
        self.assertIn("settings verified", output)

    def test_ineffective_security_and_label_mutations_fail(self):
        failures = {
            "/private-vulnerability-reporting": {"enabled": False},
            "/automated-security-fixes": {"enabled": True, "paused": True},
            "/labels/bug": {"name": "bug", "color": "ffffff", "description": "wrong"},
            "/vulnerability-alerts": RuntimeError("unavailable"),
        }
        for endpoint, value in failures.items():
            with self.subTest(endpoint=endpoint):
                result, _, output, _ = self.run_helper(overrides={endpoint: value})
                self.assertEqual(result, 1)
                self.assertIn("UNRESOLVED:", output)
                self.assertNotIn("settings verified", output)

    def test_repository_mismatches_fail_even_with_python_optimization(self):
        cases = [
            {"description": "unexpected"},
            {"topics": []},
            {"has_issues": False},
            {"has_discussions": False},
            {"security_and_analysis": {}},
        ]
        for changes in cases:
            with self.subTest(changes=changes):
                repo = {"permissions": {"admin": True}, "description": community.DESCRIPTION,
                        "topics": community.TOPICS, "has_issues": True, "has_discussions": True,
                        "security_and_analysis": {
                            "secret_scanning": {"status": "enabled"},
                            "secret_scanning_push_protection": {"status": "enabled"}}}
                repo.update(changes)
                result, _, output, _ = self.run_helper(overrides={"": repo})
                self.assertEqual(result, 1)
                self.assertIn("UNRESOLVED:", output)


if __name__ == "__main__":
    unittest.main()
