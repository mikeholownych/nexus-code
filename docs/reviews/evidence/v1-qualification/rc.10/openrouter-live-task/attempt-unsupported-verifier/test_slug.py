import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from slug import slugify

class SlugifyTests(unittest.TestCase):
    def test_normalizes_words_and_punctuation(self):
        self.assertEqual(slugify("  Hello, World! "), "hello-world")
    def test_collapses_separator_runs(self):
        self.assertEqual(slugify("already--a_slug"), "already-a-slug")
    def test_empty_result_for_punctuation_only(self):
        self.assertEqual(slugify("!!!"), "")
    def test_normalizes_version_text(self):
        self.assertEqual(slugify("Version 2.0+RC"), "version-2-0-rc")

if __name__ == "__main__":
    unittest.main()
