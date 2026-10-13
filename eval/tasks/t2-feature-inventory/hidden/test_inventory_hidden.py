import os, sys, unittest
sys.path.insert(0, os.getcwd())

from inventory import Inventory

class Hidden(unittest.TestCase):
    def setUp(self):
        self.inv = Inventory(); self.inv.add("bolt", 5)

    def test_remove(self):
        self.assertEqual(self.inv.remove("bolt", 2), 3)
        self.assertEqual(self.inv.quantity("bolt"), 3)

    def test_remove_all_drops_item(self):
        self.assertEqual(self.inv.remove("bolt", 5), 0)
        self.assertNotIn("bolt", self.inv.items())

    def test_insufficient_unchanged(self):
        with self.assertRaises(ValueError):
            self.inv.remove("bolt", 6)
        self.assertEqual(self.inv.quantity("bolt"), 5)

    def test_bad_qty(self):
        for q in [0, -1, 1.5, "2"]:
            with self.assertRaises(ValueError):
                self.inv.remove("bolt", q)

    def test_unknown(self):
        with self.assertRaises(KeyError):
            self.inv.remove("nut", 1)

unittest.main()
