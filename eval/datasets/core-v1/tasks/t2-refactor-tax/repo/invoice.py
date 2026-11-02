from decimal import Decimal, ROUND_HALF_UP


def invoice_line(qty, unit_price, rate):
    amount = Decimal(qty) * Decimal(str(unit_price))
    taxed = amount * (Decimal("1") + Decimal(str(rate)))
    return float(taxed.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def invoice_total(lines, rate):
    return round(sum(invoice_line(q, p, rate) for q, p in lines), 2)
