class Inventory:
    def __init__(self):
        self._stock = {}

    def add(self, name, qty):
        if not isinstance(qty, int) or qty <= 0:
            raise ValueError("qty must be a positive integer")
        self._stock[name] = self._stock.get(name, 0) + qty
        return self._stock[name]

    def quantity(self, name):
        return self._stock.get(name, 0)

    def items(self):
        return dict(self._stock)
