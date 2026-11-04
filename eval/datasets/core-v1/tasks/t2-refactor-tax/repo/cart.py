from decimal import Decimal, ROUND_HALF_UP


def cart_total(prices, rate):
    subtotal = sum(Decimal(str(p)) for p in prices)
    taxed = subtotal * (Decimal("1") + Decimal(str(rate)))
    return float(taxed.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))
