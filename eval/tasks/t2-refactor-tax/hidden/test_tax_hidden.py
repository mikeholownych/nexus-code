import os, sys, unittest
sys.path.insert(0, os.getcwd())

import inspect, re
import cart, invoice, pricing

class Hidden(unittest.TestCase):
    def test_apply_tax(self):
        self.assertEqual(float(pricing.apply_tax(100, 0.13)), 113.0)
        self.assertEqual(float(pricing.apply_tax(0.125, 0)), 0.13)
        self.assertEqual(float(pricing.apply_tax(10.005, 0)), 10.01)

    def test_behaviour_unchanged(self):
        self.assertEqual(cart.cart_total([10, 5.5], 0.13), 17.52)
        self.assertEqual(cart.cart_total([0.105], 0), 0.11)
        self.assertEqual(invoice.invoice_line(3, 2.25, 0.05), 7.09)
        self.assertEqual(invoice.invoice_total([(1, 10), (2, 2.5)], 0.13), 16.95)

    def test_no_duplicate_tax_code(self):
        for mod in (cart, invoice):
            src = inspect.getsource(mod)
            self.assertIn("apply_tax", src, mod.__name__)
            self.assertIsNone(re.search(r"ROUND_HALF_UP|quantize", src), f"{mod.__name__} still rounds itself")

unittest.main()
