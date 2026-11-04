import os, sys, unittest
sys.path.insert(0, os.getcwd())

from durations import parse_duration

class Hidden(unittest.TestCase):
    def test_examples(self):
        self.assertEqual(parse_duration("1h30m"), 5400)
        self.assertEqual(parse_duration("45m"), 2700)
        self.assertEqual(parse_duration("20s"), 20)
        self.assertEqual(parse_duration("1h1m1s"), 3661)
        self.assertEqual(parse_duration(" 2H "), 7200)

    def test_invalid(self):
        for bad in ["", "abc", "10x", "5"]:
            with self.assertRaises(ValueError):
                parse_duration(bad)

unittest.main()
