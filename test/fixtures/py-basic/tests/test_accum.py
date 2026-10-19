import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from calc.accum import Accumulator


def test_accumulator_skips_none():
    acc = Accumulator().add(1).add(None).add(2)
    assert acc.total() == 3
