class Accumulator:
    def __init__(self):
        self.items = []

    def add(self, value):
        if value is None:
            return self
        self.items.append(value)
        return self

    def total(self):
        return sum(self.items)
