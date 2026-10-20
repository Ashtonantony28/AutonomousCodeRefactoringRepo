# AUDIT-11: runs src/validation/py_diff_harness.py under coverage.py.
# Started (instead of the harness) by the python3 shim that
# audit/11/py-coverage.js puts first on PATH:
#   python3 -I -B py-cov-launcher.py <harness> <coverage-site-dir> <data-dir>
# The harness forks one child per side, installs an audit hook in each child
# that refuses writes outside its cwd, and leaves the child with os._exit.
# coverage.py restarts in each forked child (patch = fork, with
# COVERAGE_PROCESS_START pointing at the rc file), os._exit is wrapped to save
# the child's data first, and the audit hook the harness adds is wrapped so
# it stands aside only while that data file is written.
# Measurement only: nothing under src/ is modified.
import os
import sys

harness, site, data_dir = sys.argv[1], sys.argv[2], sys.argv[3]
sys.path.append(site)
import coverage  # noqa: E402

rc = os.path.join(data_dir, 'rc.ini')
os.environ['COVERAGE_PROCESS_START'] = rc
saving = [False]
real_add = sys.addaudithook
real_exit = os._exit


def add_hook(hook):
    def wrapped(event, args):
        if saving[0]:
            return
        return hook(event, args)
    return real_add(wrapped)


def final_exit(status):
    saving[0] = True
    try:
        c = coverage.Coverage.current()
        if c is not None:
            c.stop()
            c.save()
    except Exception:
        pass
    real_exit(status)


sys.addaudithook = add_hook
cov = coverage.Coverage(config_file=rc)
cov.start()
os._exit = final_exit
os.register_at_fork(after_in_child=lambda: setattr(os, '_exit', final_exit))
sys.argv = [harness]
import runpy  # noqa: E402
try:
    runpy.run_path(harness, run_name='__main__')
finally:
    saving[0] = True
    cov.stop()
    cov.save()
