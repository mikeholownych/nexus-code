import os, sys, unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from cart import cart_total
from invoice import invoice_line, invoice_total


class Totals(unittest.TestCase):
    def test_cart(self):
        self.assertEqual(cart_total([10, 5.5], 0.13), 17.52)

    def test_invoice(self):
        self.assertEqual(invoice_line(3, 2.25, 0.05), 7.09)
        self.assertEqual(invoice_total([(1, 10), (2, 2.5)], 0.13), 16.95)


if __name__ == "__main__":
    unittest.main()
