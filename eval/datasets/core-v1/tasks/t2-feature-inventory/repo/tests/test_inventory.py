import os, sys, unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from inventory import Inventory


class InventoryTest(unittest.TestCase):
    def test_add(self):
        inv = Inventory()
        self.assertEqual(inv.add("bolt", 3), 3)
        self.assertEqual(inv.add("bolt", 2), 5)

    def test_add_rejects_zero(self):
        with self.assertRaises(ValueError):
            Inventory().add("bolt", 0)


if __name__ == "__main__":
    unittest.main()
