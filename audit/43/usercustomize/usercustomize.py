# AUDIT-43 U1: an operator usercustomize (imported by site after every
# sitecustomize) that installs its own excepthook, chaining to the default.
import sys


def _operator_hook(*a):
    sys.__excepthook__(*a)


sys.excepthook = _operator_hook
