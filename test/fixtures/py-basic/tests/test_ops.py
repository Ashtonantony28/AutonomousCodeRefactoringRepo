import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from calc.ops import total


def test_total():
    assert total([1, 2, 3]) == 6
    assert total([]) == 0
