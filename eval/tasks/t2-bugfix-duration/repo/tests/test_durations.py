import os, sys, unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from durations import parse_duration


class DurationTest(unittest.TestCase):
    def test_hours_and_minutes(self):
        self.assertEqual(parse_duration("1h30m"), 5400)

    def test_hours(self):
        self.assertEqual(parse_duration("2h"), 7200)


if __name__ == "__main__":
    unittest.main()
