# AUDIT-43 control: an operator sitecustomize that installs its own excepthook
# (SG51 wraps it).
import sys


def _operator_hook(*a):
    sys.__excepthook__(*a)


sys.excepthook = _operator_hook
