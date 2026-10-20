"""Python side of differential testing (driven by py-diff-testing.js).

Reads {current, proposed, filename, modname, snippet, deleted, budget_ms,
call_timeout_ms} as JSON on stdin and prints one JSON line: the DiffTest
contract fields plus function_name, arity and deletions_observed.

The parent parses both versions, locates the changed callables (top-level
functions, methods, static/class methods, properties, __init__) and changed
top-level assignments, and builds inputs shaped by how the current version
uses each parameter (methods called on it, subscripts, arithmetic, iteration,
comparisons, calls, defaults) from literals mined from both versions and
boundary values derived from them. Each side runs in its own forked child:
fresh empty cwd, address-space / CPU / file-size limits, an audit hook that
refuses network, processes, ctypes and writes outside the cwd, captured
stdout/stderr (log records of every level and every warning included),
recording stubs for non-stdlib imports and a per-call timer.
The current version runs twice so nondeterminism is not taken for a change.

Each call records the return value (or exception type, plus its arguments
when the module raised it explicitly), the arguments and `self` after the
call, whether an argument or an earlier result was returned, captured output,
module-scope state, files in the cwd and stub interactions; the whole list of
inputs runs twice per side, so state carried between calls is seen. Verdicts
follow the JS oracle: a mismatch is divergent unless the current version
rejected the input with a TypeError/AttributeError (outside its domain);
stub-dependent or nondeterministic differences, timeouts, skipped targets and
too few value-returning runs are inconclusive. Floats compare with a 1e-9
relative tolerance (sum() vs a loop).
"""
import ast
import bisect
import builtins
import copy
import io
import json
import math
import os
import random
import re
import resource
import select
import shutil
import signal
import sys
import time
import types

SEED = 42
MAX_TARGETS = 8
MAX_INPUTS = 40
MIN_VALUE_RUNS = 10
MAX_RUNS = 100
MAX_DEPTH = 24
MAX_NODES = 20000
MEM_BYTES = 1 << 30
OUT_CAP = 10000
OMIT = object()

STDLIB = set(getattr(sys, 'stdlib_module_names', ())) or {
    'abc', 'collections', 'copy', 'dataclasses', 'datetime', 'decimal', 'enum', 'fractions', 'functools', 'hashlib',
    'heapq', 'itertools', 'json', 'logging', 'math', 'operator', 'os', 'random', 're', 'statistics', 'string', 'sys',
    'textwrap', 'time', 'typing', 'unicodedata', 'uuid', 'bisect', 'contextlib', 'pathlib', 'io', 'struct'}
STUBBED_STDLIB = {'ctypes', 'subprocess', 'socket', 'ssl', 'multiprocessing', 'signal', 'resource', 'pty', 'webbrowser',
                  'ftplib', 'smtplib', 'poplib', 'imaplib', 'telnetlib', 'socketserver', 'xmlrpc', 'select', 'selectors'}
BLOCKED_EVENTS = ('socket.', 'subprocess.', 'os.system', 'os.exec', 'os.posix_spawn', 'os.spawn', 'os.fork', 'os.forkpty',
                  'os.kill', 'os.killpg', 'os.chdir', 'os.fchdir', 'os.chroot', 'os.symlink', 'os.link', 'os.mkfifo', 'os.mknod',
                  'ctypes.', 'urllib.Request', 'webbrowser.', 'resource.setrlimit', 'resource.prlimit', 'sys.addaudithook',
                  '_thread.start_new_thread', 'os.startfile', 'pty.')
PATH_EVENTS = {'os.remove', 'os.rename', 'os.rmdir', 'os.mkdir', 'shutil.rmtree', 'os.chmod', 'os.chown', 'os.truncate',
               'os.utime', 'shutil.move', 'shutil.copyfile', 'shutil.copytree', 'os.replace'}
NONDET = {'time', 'datetime', 'random', 'uuid', 'secrets', 'environ', 'getenv', 'getpid', 'urandom', 'now', 'today',
          'utcnow', 'perf_counter', 'monotonic', 'process_time', 'getrandbits'}
ITER_FUNCS = {'len', 'sum', 'sorted', 'min', 'max', 'list', 'tuple', 'set', 'frozenset', 'any', 'all', 'enumerate', 'zip',
              'reversed', 'iter', 'map', 'filter', 'next', 'join'}
NUM_FUNCS = {'abs', 'round', 'divmod', 'pow', 'chr', 'hex', 'bin', 'oct', 'range', 'math'}
METHOD_KINDS = {
    **{m: ('str',) for m in ('lower', 'upper', 'strip', 'lstrip', 'rstrip', 'split', 'rsplit', 'splitlines', 'replace',
                             'startswith', 'endswith', 'encode', 'format', 'isdigit', 'isalpha', 'isalnum', 'isspace',
                             'title', 'capitalize', 'casefold', 'zfill', 'center', 'ljust', 'rjust', 'partition',
                             'rpartition', 'find', 'rfind', 'removeprefix', 'removesuffix', 'swapcase', 'isupper',
                             'islower', 'isnumeric', 'isdecimal', 'expandtabs', 'translate')},
    **{m: ('list',) for m in ('append', 'extend', 'insert', 'remove', 'sort', 'reverse')},
    **{m: ('dict',) for m in ('keys', 'values', 'items', 'get', 'setdefault', 'popitem')},
    **{m: ('set',) for m in ('add', 'discard', 'union', 'intersection', 'difference', 'issubset', 'issuperset')},
    'pop': ('list', 'dict'), 'copy': ('list', 'dict'), 'clear': ('list', 'dict'), 'update': ('dict',),
    'count': ('seq',), 'index': ('seq',), 'decode': ('bytes',), 'join': ('str',)}


class CallTimeout(BaseException):
    pass


# --- recording values ---------------------------------------------------------

STUB_LOG = []


class StubBase:
    pass


class Stub:
    """Inert stand-in for a module the sandbox does not import."""
    __slots__ = ('_p',)

    def __init__(self, p):
        object.__setattr__(self, '_p', p)

    def __getattr__(self, k):
        if k.startswith('__') and k.endswith('__'):
            raise AttributeError(k)
        STUB_LOG.append(['get', f'{self._p}.{k}'])
        return Stub(f'{self._p}.{k}')

    def __setattr__(self, k, v):
        STUB_LOG.append(['set', f'{self._p}.{k}', Norm()(v)])

    def __call__(self, *a, **k):
        STUB_LOG.append(['call', self._p, Norm()(a), Norm()(k)])
        return Stub(self._p + '()')

    def __getitem__(self, k):
        return Stub(self._p + '[]')

    def __iter__(self):
        return iter(())

    def __bool__(self):
        return True

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def __mro_entries__(self, bases):
        return (StubBase,)

    def __repr__(self):
        return f'<stub {self._p}>'


class Callback:
    """Callable input: records its calls, answers by kind."""

    def __init__(self, kind):
        self.kind = kind
        self.calls = []

    def __call__(self, *a, **k):
        if len(self.calls) < 50:
            self.calls.append(Norm()([a, k]))
        if self.kind == 'id':
            return a[0] if a else None
        return {'true': True, 'false': False, 'one': 1}.get(self.kind)

    def __repr__(self):
        return f'<callback {self.kind}>'


class Drained:
    def __init__(self, items):
        self.items = items


ADDR = re.compile(r' at 0x[0-9a-fA-F]+')


class Norm:
    """Value -> JSON-able tagged tree; flags stub values and truncation."""

    def __init__(self):
        self.n = 0
        self.stub = False
        self.trunc = False
        self.stack = set()

    def __call__(self, v, d=0):
        self.n += 1
        if self.n > MAX_NODES or d > MAX_DEPTH:
            self.trunc = True
            return ['T']
        t = type(v)
        if v is None:
            return ['N']
        if t is bool:
            return ['b', v]
        if t is int:
            return ['i', str(v)]
        if t is float:
            return ['f', v]
        if t is str:
            return ['s', v]
        if t in (bytes, bytearray):
            return ['y', t.__name__, v.hex()]
        if t is complex:
            return ['c', ['f', v.real], ['f', v.imag]]
        if t is Stub:
            self.stub = True
            return ['stub', v._p]
        if t is Callback:
            return ['cb', v.kind, v.calls]
        if t is Drained:
            return ['gen', [self(x, d + 1) for x in v.items]]
        if isinstance(v, (types.FunctionType, types.BuiltinFunctionType, types.MethodType)):
            return ['fn', getattr(v, '__qualname__', '?')]
        if isinstance(v, types.ModuleType):
            return ['mod', v.__name__]
        if isinstance(v, type):
            return ['type', getattr(v, '__qualname__', '?')]
        if isinstance(v, (types.GeneratorType, types.CoroutineType)):
            return ['gen?']
        key = id(v)
        if key in self.stack:
            return ['cyc']
        self.stack.add(key)
        try:
            if isinstance(v, BaseException):
                return ['E', t.__name__, self(v.args, d + 1)]
            if isinstance(v, dict):
                return ['D', t.__name__, [[self(k, d + 1), self(x, d + 1)] for k, x in v.items()]]
            if isinstance(v, (list, tuple)) or t.__name__ == 'deque':
                return ['L', t.__name__, [self(x, d + 1) for x in v]]
            if isinstance(v, (set, frozenset)):
                return ['S', t.__name__, sorted(json.dumps(self(x, d + 1)) for x in v)]
            if t.__repr__ is object.__repr__ and hasattr(v, '__dict__'):
                return ['O', t.__qualname__, [[k, self(x, d + 1)] for k, x in vars(v).items()]]
            try:
                r = ADDR.sub('', repr(v))[:500]
            except Exception as e:
                r = f'<repr error {type(e).__name__}>'
            return ['R', t.__name__, r]
        finally:
            self.stack.discard(key)


def feq(x, y):
    if x == y:
        return True
    if isinstance(x, float) and isinstance(y, float):
        if math.isnan(x) and math.isnan(y):
            return True
        return math.isfinite(x) and math.isfinite(y) and math.isclose(x, y, rel_tol=1e-9, abs_tol=1e-12)
    return False


def eq(a, b):
    if type(a) is not type(b):
        return False
    if type(a) is list:
        if len(a) == 2 and a[0] == 'f' and b[0] == 'f':
            return feq(a[1], b[1])
        return len(a) == len(b) and all(eq(x, y) for x, y in zip(a, b))
    if type(a) is dict:
        return a.keys() == b.keys() and all(eq(a[k], b[k]) for k in a)
    return a == b


# --- static analysis ----------------------------------------------------------

def dump(n):
    return ast.dump(n, include_attributes=False)


def is_docstring(s):
    return isinstance(s, ast.Expr) and isinstance(s.value, ast.Constant) and isinstance(s.value.value, str)


def decorators(fn):
    out = set()
    for d in fn.decorator_list:
        if isinstance(d, ast.Name):
            out.add(d.id)
        elif isinstance(d, ast.Attribute):
            out.add(d.attr)
    return out


def layout(tree):
    """-> {qualname: (kind, node, cls)}, {name: dump} for assignments, [other dumps]"""
    fns, values, other = {}, {}, []
    FN = (ast.FunctionDef, ast.AsyncFunctionDef)
    for s in tree.body:
        if isinstance(s, FN):
            fns[s.name] = ('fn', s, None)
        elif isinstance(s, ast.ClassDef):
            rest = []
            for m in s.body:
                if isinstance(m, FN):
                    dec = decorators(m)
                    kind = ('static' if 'staticmethod' in dec else 'classmethod' if 'classmethod' in dec
                            else 'property' if 'property' in dec or 'cached_property' in dec
                            else 'skip' if dec & {'setter', 'deleter'} else 'init' if m.name == '__init__' else 'method')
                    if kind != 'skip':
                        fns[f'{s.name}.{m.name}'] = (kind, m, s)
                    else:
                        rest.append(dump(m))
                elif not (isinstance(m, (ast.Assign, ast.AnnAssign, ast.Pass)) or is_docstring(m)):
                    rest.append(dump(m))
            other.append('class ' + s.name + ':' + dump(ast.Tuple(elts=s.bases + s.decorator_list, ctx=ast.Load())) + repr(rest))
        elif isinstance(s, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
            tg = s.targets if isinstance(s, ast.Assign) else [s.target]
            names = [n.id for t in tg for n in ast.walk(t) if isinstance(n, ast.Name)]
            for nm in names:
                values[nm] = values.get(nm, '') + dump(s)
            if not names:
                other.append(dump(s))
        elif isinstance(s, (ast.Import, ast.ImportFrom)) or is_docstring(s) or isinstance(s, ast.Pass):
            continue
        else:
            other.append(dump(s))
    return fns, values, other


def names_in(node):
    out = set()
    for n in ast.walk(node):
        if isinstance(n, ast.Name):
            out.add(n.id)
        elif isinstance(n, ast.Attribute):
            out.add(n.attr)
    return out


def literals(nodes):
    ints, floats, strs = [], [], []
    for node in nodes:
        for n in ast.walk(node):
            if isinstance(n, ast.Constant):
                v = n.value
                if type(v) is int and abs(v) < 10 ** 12:
                    neg = isinstance(getattr(n, '_p', None), ast.UnaryOp) and isinstance(n._p.op, ast.USub)
                    ints.append(-v if neg else v)
                elif type(v) is float:
                    floats.append(v)
                elif type(v) is str and len(v) <= 40 and not (isinstance(getattr(n, '_p', None), ast.Expr)):
                    strs.append(v)
    uniq = lambda xs: list(dict.fromkeys(xs))
    return uniq(ints)[:16], uniq(floats)[:8], uniq(strs)[:16]


class Hint:
    def __init__(self):
        self.kinds = set()
        self.keys = []
        self.attrs = []
        self.elem = None


def call_name(f):
    if isinstance(f, ast.Name):
        return f.id
    if isinstance(f, ast.Attribute):
        base = call_name(f.value)
        return f'{base}.{f.attr}' if base else f.attr
    return ''


def const_kind(n, int_vars):
    if isinstance(n, ast.UnaryOp) and isinstance(n.op, ast.USub):
        n = n.operand
    if isinstance(n, ast.Constant):
        v = n.value
        if type(v) in (int, float):
            return 'num'
        if type(v) is str:
            return 'str'
        if v is None:
            return 'none'
    if isinstance(n, ast.Name) and n.id in int_vars:
        return 'num'
    if isinstance(n, ast.Call) and call_name(n.func) in ('len', 'int', 'float', 'abs', 'round', 'sum'):
        return 'num'
    return None


def use(h, n, int_vars):
    par = getattr(n, '_p', None)
    if isinstance(par, ast.Attribute) and par.value is n:
        gp = getattr(par, '_p', None)
        if isinstance(gp, ast.Call) and gp.func is par:
            k = METHOD_KINDS.get(par.attr)
            if k:
                h.kinds.update(k)
                if par.attr in ('get', 'pop', 'setdefault') and gp.args and isinstance(gp.args[0], ast.Constant) and isinstance(gp.args[0].value, str):
                    h.keys.append(gp.args[0].value)
            else:
                h.kinds.add('obj')
                h.attrs.append((par.attr, True))
        else:
            h.kinds.add('obj')
            h.attrs.append((par.attr, False))
    elif isinstance(par, ast.Subscript) and par.value is n:
        s = par.slice
        ck = const_kind(s, int_vars)
        if isinstance(s, ast.Slice) or ck == 'num':
            h.kinds.add('seq')
        elif ck == 'str':
            h.kinds.add('dict')
            h.keys.append(s.value)
        else:
            h.kinds.update(('dict', 'list'))
    elif isinstance(par, ast.Call):
        if par.func is n:
            h.kinds.add('call')
        elif n in par.args:
            f = call_name(par.func)
            base = f.split('.')[0]
            last = f.split('.')[-1]
            if f in ITER_FUNCS or (last == 'join' and par.args and par.args[0] is n):
                h.kinds.add('iter')
            elif f in NUM_FUNCS or base == 'math':
                h.kinds.add('int' if f == 'range' else 'num')
            elif f == 'open' or f.startswith('os.path.') or base in ('shutil', 'pathlib'):
                h.kinds.add('path')
            elif f in ('int', 'float'):
                h.kinds.update(('num', 'str'))
            else:
                h.kinds.add('any')
        else:
            h.kinds.add('any')
    elif isinstance(par, ast.Starred):
        h.kinds.add('iter')
    elif isinstance(par, (ast.BinOp, ast.AugAssign)):
        if isinstance(par, ast.BinOp):
            other = par.right if par.left is n else par.left
            left = par.left is n
        else:
            other = par.value if par.target is n else par.target
            left = par.target is n
        op = type(par.op)
        ck = const_kind(other, int_vars)
        if op is ast.Mod and not left and ck == 'str':
            h.kinds.add('any')
        elif ck == 'num' or op in (ast.Sub, ast.Div, ast.FloorDiv, ast.Pow, ast.LShift, ast.RShift, ast.BitAnd, ast.BitOr, ast.BitXor):
            h.kinds.add('num')
        elif ck == 'str':
            h.kinds.add('str')
        else:
            h.kinds.add('any')
    elif isinstance(par, ast.UnaryOp) and not isinstance(par.op, ast.Not):
        h.kinds.add('num')
    elif isinstance(par, ast.Compare):
        operands = [par.left] + par.comparators
        i = next(k for k, x in enumerate(operands) if x is n)
        for j in (i - 1, i):
            if j < 0 or j >= len(par.ops):
                continue
            op, other = par.ops[j], operands[j + 1 if j == i else j]
            if isinstance(op, (ast.In, ast.NotIn)):
                h.kinds.add('container' if j == i - 1 else 'any')
            elif isinstance(op, (ast.Lt, ast.Gt, ast.LtE, ast.GtE)):
                h.kinds.add('str' if const_kind(other, int_vars) == 'str' else 'num')
            else:
                ck = const_kind(other, int_vars)
                h.kinds.add({'num': 'num', 'str': 'str'}.get(ck, 'any'))
                h.kinds.add('any')
    elif isinstance(par, (ast.For, ast.comprehension)) and par.iter is n:
        h.kinds.add('iter')
    elif isinstance(par, ast.keyword) and par.arg is None:
        h.kinds.add('dict')
    else:
        h.kinds.add('any')


def analyze(fn, params, extra=None):
    """Hints per parameter (and per `self.attr` path when `extra` maps them)."""
    hints = {p: Hint() for p in params}
    alias = {p: (p, 0) for p in params}
    int_vars = set()
    for n in ast.walk(fn):
        if isinstance(n, (ast.For, ast.comprehension)):
            it, tg = n.iter, n.target
            if isinstance(it, ast.Call) and call_name(it.func) == 'range' and isinstance(tg, ast.Name):
                int_vars.add(tg.id)
            if isinstance(it, ast.Call) and call_name(it.func) == 'enumerate' and it.args and isinstance(tg, ast.Tuple) and len(tg.elts) == 2:
                if isinstance(tg.elts[0], ast.Name):
                    int_vars.add(tg.elts[0].id)
                it, tg = it.args[0], tg.elts[1]
            if isinstance(it, ast.Name) and it.id in alias and alias[it.id][1] == 0 and isinstance(tg, ast.Name):
                alias.setdefault(tg.id, (alias[it.id][0], 1))
        elif isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name):
            v = n.value
            if isinstance(v, ast.Name) and v.id in alias:
                alias.setdefault(n.targets[0].id, alias[v.id])
            elif const_kind(v, int_vars) == 'num':
                int_vars.add(n.targets[0].id)
    for n in ast.walk(fn):
        if isinstance(n, ast.Name) and n.id in alias and not isinstance(n.ctx, ast.Store):
            p, lvl = alias[n.id]
            h = hints[p]
            if lvl:
                h.elem = h.elem or Hint()
                h = h.elem
            use(h, n, int_vars)
        elif extra and isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name) and n.value.id == 'self' \
                and n.attr in extra and not isinstance(n.ctx, ast.Store):
            use(hints.setdefault(extra[n.attr], Hint()), n, int_vars)
    return hints


# --- inputs -------------------------------------------------------------------

def flip(s):
    return s.swapcase()


def pools_from(lits):
    """-> (ints, floats, strings, mined strings, mined lengths)"""
    ints, floats, strs = lits
    uniq = lambda xs: list(dict.fromkeys(xs))
    I = [0, 1, -1, 2, 3, 7, 10, 100]
    for v in ints:
        I += [v, v - 1, v + 1]
    F = [0.5, -2.5, 1.234, 0.1, 3.0] + floats + [float(v) + 0.5 for v in ints[:4]]
    M = []
    for s in strs:
        M += [s, flip(s), s + 'x', 'x' + s, s * 2]
    M = uniq(M)[:30]
    S = uniq(['', 'a', ' a', 'a ', ' A b ', 'Hello World'] + M + ['ab', 'ABCDEFGHIJKL', '\u20ac', '0', '42', 'a,b', 'a.b', '../x'])
    L = uniq(n for v in ints for n in (v - 1, v, v + 1) if 0 < n <= 60)[:8]
    return uniq(I)[:40], uniq(F)[:16], S[:48], M, L


def lists_of(elems, rng):
    e = elems
    out = [[], [e[0]], [e[0], e[1 % len(e)]], [e[1 % len(e)], e[0], e[2 % len(e)]], [e[0], e[0]], list(e[:6]), list(reversed(e[:5]))]
    for size in (2, 3, 4, 5):
        out.append([rng.choice(e) for _ in range(size)])
    try:
        out += [sorted(e)[:6], sorted(e, reverse=True)[:6]]
    except TypeError:
        pass
    return out


def pool(h, P, depth=0, rng=None):
    I, F, S, M, L = P
    rng = rng or random.Random(SEED)
    k = set(h.kinds) if h else set()
    if h and h.elem and depth == 0:
        elems = [v for v in pool(h.elem, P, 1, rng) if v is not None][:12]
    else:
        elems = None
    generic_lists = [[1, 2, 3], [3, 1, 2], [-1, 2], [1, -1, -2], [0.1, 0.2, 0.3], ['a', 'b'], [' a ', 'B'], ['a', 'a'], [1, 'a'], [[1], [2]]]
    lists = lists_of(elems, rng) if elems else [[]] + generic_lists
    lists += [list(range(n)) for n in L + [4, 12]]
    keys = list(dict.fromkeys((h.keys if h else []) + [s for s in M if s][:6]))
    dicts = [{}, {'a': 1}, {'b': 1, 'a': 2}, {'x': None, 'y': [1]}, {1: 'a', 2: 'b'}]
    for key in keys[:6]:
        dicts += [{key: v} for v in (True, False, 0, 1, 'x', None, [1], 2.5)]
    if len(keys) > 1:
        dicts.append({keys[1]: 2, keys[0]: 1})
    out = [None]
    if len(k) > 1:
        k.discard('any')
    if not k or k == {'any'}:
        return out + I[:8] + F[:3] + S[:14] + [True, False] + lists[:6] + dicts[:5]
    if 'num' in k:
        out += I + F
    if 'int' in k:
        out += I
    if 'str' in k:
        out += S
    if 'path' in k:
        out += ['f.txt', 'a', 'out.log', 'sub'] + [s for s in M if s and '/' not in s and '\0' not in s][:10]
    if 'bytes' in k:
        out += [b'', b'a', b'ab c', '€'.encode()]
    if 'seq' in k or 'iter' in k:
        out += lists + [tuple(x) for x in lists[:4]] + S[:6]
    if 'list' in k:
        out += lists
    if 'dict' in k:
        out += dicts
    if 'set' in k:
        out += [set(), {1, 2}, {'a'}, {1, 2, 3}]
    if 'container' in k:
        out += lists[:5] + S[:5] + dicts[:6] + [{1, 2}]
    if 'obj' in k:
        attrs = list(dict.fromkeys(h.attrs))
        vals = I[:4] + S[:4] + [None, True]
        for i in range(4):
            out.append(types.SimpleNamespace(**{a: (Callback(('id', 'true', 'one', 'false')[i]) if called else vals[(i + j) % len(vals)])
                                                for j, (a, called) in enumerate(attrs)}))
    if 'call' in k:
        out += [Callback('id'), Callback('true'), Callback('false'), Callback('one')]
    seen, res = set(), []
    for v in out:
        key = (type(v).__name__, repr(v))
        if key not in seen:
            seen.add(key)
            res.append(v)
    return res


def signature(fn, skip_first):
    a = fn.args
    pos = [x.arg for x in a.posonlyargs + a.args]
    defaults = [None] * (len(pos) - len(a.defaults)) + list(a.defaults)
    if skip_first and pos:
        pos, defaults = pos[1:], defaults[1:]
    kwonly = [(x.arg, d is not None) for x, d in zip(a.kwonlyargs, a.kw_defaults)]
    return pos, defaults, kwonly, a.vararg is not None


def literal(node):
    try:
        return ast.literal_eval(node)
    except Exception:
        return OMIT


def build_inputs(fn, skip_first, hints, P, rng):
    pos, defaults, kwonly, vararg = signature(fn, skip_first)
    pools = {}
    for name, d in zip(pos, defaults):
        p = pool(hints.get(name), P, rng=rng)
        if d is not None:
            dv = literal(d)
            p = ([OMIT] + ([dv] if dv is not OMIT else []) + p)
        pools[name] = p
    for name, has_default in kwonly:
        p = pool(hints.get(name), P, rng=rng)
        pools[name] = ([OMIT] if has_default else []) + p
    names = pos + [n for n, _ in kwonly]
    if not names:
        return [((), {})]
    typical = {n: OMIT if pools[n][0] is OMIT else next((v for v in pools[n] if v is not None), None) for n in names}
    out, seen = [], set()

    def add(vals):
        args = []
        for n in pos:
            v = vals[n]
            if v is OMIT:
                break
            args.append(v)
        kw = {n: vals[n] for n, _ in kwonly if vals[n] is not OMIT}
        key = repr((args, sorted(kw.items())))
        if key not in seen and len(out) < MAX_INPUTS:
            seen.add(key)
            out.append((tuple(args), kw))

    per = max(6, 30 // len(names))
    for n in names:
        for v in pools[n][:per]:
            add({**typical, n: v})
    for _ in range(400):
        if len(out) >= MAX_INPUTS:
            break
        add({n: rng.choice(pools[n]) for n in names})
    if vararg and out:
        a, kw = out[0]
        out[-1] = (a + (1, 'a'), kw)
    return out


# --- sandboxed side -----------------------------------------------------------

class Capture:
    def __init__(self):
        self.buf = []
        self.size = 0

    def write(self, s):
        s = str(s)
        if self.size < OUT_CAP:
            self.buf.append(s[:OUT_CAP - self.size])
        self.size += len(s)
        return len(s)

    def flush(self):
        pass

    def isatty(self):
        return False

    def text(self):
        return ADDR.sub('', ''.join(self.buf)) + (f'...<{self.size}>' if self.size > OUT_CAP else '')

    def clear(self):
        self.buf, self.size = [], 0


def on_alarm(*_):
    raise CallTimeout()


class Timer:
    def __init__(self, s):
        self.s = s

    def __enter__(self):
        signal.setitimer(signal.ITIMER_REAL, self.s)

    def __exit__(self, *a):
        signal.setitimer(signal.ITIMER_REAL, 0)
        return False


def audit_hook(root):
    busy = [False]
    prefix = root.rstrip(os.sep) + os.sep

    def inside(p):
        if isinstance(p, int):
            return True
        try:
            p = os.fsdecode(p)
        except Exception:
            return False
        return os.path.abspath(p).startswith(prefix)

    def hook(event, args):
        if busy[0]:
            return
        busy[0] = True
        try:
            if event.startswith(BLOCKED_EVENTS):
                raise PermissionError(f'blocked by the diff-test sandbox: {event}')
            if event == 'open' and len(args) >= 3:
                path, mode, flags = args[0], args[1], args[2]
                write = (mode is not None and any(c in str(mode) for c in 'wax+')) or \
                    (mode is None and isinstance(flags, int) and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_APPEND | os.O_TRUNC))
                if write and not inside(path):
                    raise PermissionError(f'blocked by the diff-test sandbox: write outside the sandbox cwd')
            elif event in PATH_EVENTS or event == 'sqlite3.connect':
                for p in args[:2]:
                    if isinstance(p, (str, bytes, os.PathLike)) and p not in (':memory:', b':memory:') and not inside(p):
                        raise PermissionError(f'blocked by the diff-test sandbox: {event} outside the sandbox cwd')
        finally:
            busy[0] = False
    return hook


def make_import():
    real = builtins.__import__

    def imp(name, globals=None, locals=None, fromlist=(), level=0):
        top = name.split('.')[0]
        if level == 0 and top in STDLIB and top not in STUBBED_STDLIB:
            return real(name, globals, locals, fromlist, level)
        return Stub('.' * level + (name if fromlist else top))
    return imp


def module_state(mod, modname, nm):
    out = []
    for k, v in list(mod.__dict__.items()):
        if (k.startswith('__') and k.endswith('__')) or isinstance(v, (types.ModuleType, Stub, types.FunctionType, types.BuiltinFunctionType)):
            continue
        if isinstance(v, type):
            if getattr(v, '__module__', None) != modname:
                continue
            attrs = [[a, nm(x)] for a, x in list(vars(v).items())
                     if not (a.startswith('__') and a.endswith('__')) and not callable(x)
                     and not isinstance(x, (staticmethod, classmethod, property))]
            out.append([k, ['cls', attrs]])
        else:
            out.append([k, nm(v)])
    return out


def files_state():
    out = []
    for root, dirs, files in os.walk('.'):
        dirs.sort()
        for f in sorted(files)[:50]:
            p = os.path.join(root, f)
            try:
                with open(p, 'rb') as h:
                    out.append([p, h.read(4096).decode('latin-1')])
            except Exception as e:
                out.append([p, f'<{type(e).__name__}>'])
        if len(out) > 50:
            break
    return out


def exc_rec(e, filename, raise_lines, nm):
    tb, last = e.__traceback__, None
    while tb is not None:
        last, tb = tb, tb.tb_next
    user = last is not None and last.tb_frame.f_code.co_filename == filename and last.tb_lineno in raise_lines
    return {'t': type(e).__qualname__, 'user': user, 'msg': str(e)[:300], 'args': nm(e.args)}


def drive(coro):
    """Run a coroutine without an event loop (the sandbox has no sockets)."""
    for _ in range(10000):
        try:
            coro.send(None)
        except StopIteration as e:
            return e.value
    coro.close()
    raise RuntimeError('coroutine did not finish without an event loop')


def resolve(mod, t, init_args):
    cls = getattr(mod, t['cls']) if t['cls'] else None
    kind, name = t['kind'], t['name']
    if kind == 'fn':
        return getattr(mod, name), None
    if kind in ('static', 'classmethod'):
        return getattr(cls, name), None
    obj = cls(*init_args)
    if kind == 'init':
        return None, obj
    return getattr(obj, name), obj


def side_main(code, filename, modname, raise_lines, plan, deadline, wfd, workdir, call_timeout, n_probes):
    devnull = os.open(os.devnull, os.O_RDWR)
    for fd in (0, 1, 2):
        os.dup2(devnull, fd)
    try:
        import ctypes
        ctypes.CDLL(None).prctl(1, signal.SIGKILL)
    except Exception:
        pass
    resource.setrlimit(resource.RLIMIT_CPU, (4, 5))
    resource.setrlimit(resource.RLIMIT_FSIZE, (1 << 20, 1 << 20))
    signal.signal(signal.SIGXFSZ, signal.SIG_IGN)
    signal.signal(signal.SIGALRM, on_alarm)
    os.chdir(workdir)
    w = os.fdopen(wfd, 'w', encoding='utf-8')
    emit = lambda rec: (w.write(json.dumps(rec) + '\n'), w.flush())
    hits = [0] * n_probes

    def hit(k):
        hits[k] += 1

    out = Capture()
    sys.stdout = sys.stderr = out
    sys.stdin = io.StringIO('')
    # Log records of every level and every warning are output too.
    import logging
    import warnings
    logging.basicConfig(stream=out, level=logging.DEBUG, format='%(levelname)s:%(name)s:%(message)s', force=True)
    warnings.simplefilter('always')
    random.seed(SEED)
    sys.addaudithook(audit_hook(workdir))

    mod = types.ModuleType(modname)
    bdict = dict(builtins.__dict__)
    bdict['__import__'] = make_import()
    bdict['__dt_hit__'] = hit
    mod.__dict__.update({'__builtins__': bdict, '__file__': filename})
    sys.modules[modname] = mod

    def finish_rec(rec, nm, extra):
        try:
            with Timer(call_timeout):
                for k, v in extra.items():
                    rec[k] = nm(v) if v is not None else None
                rec['state'] = module_state(mod, modname, nm)
                rec['files'] = files_state()
        except CallTimeout:
            return {'k': 'timeout'}
        rec['out'] = out.text()
        rec['stubs'] = list(STUB_LOG)
        rec['stub'] = nm.stub
        rec['trunc'] = nm.trunc
        return rec

    nm = Norm()
    rec = {'k': 'value'}
    try:
        with Timer(max(call_timeout, 1.0)):
            exec(code if isinstance(code, types.CodeType) else compile(code, filename, 'exec'), mod.__dict__)
    except CallTimeout:
        rec = {'k': 'timeout'}
    except BaseException as e:
        rec = {'k': 'throw', 'e': exc_rec(e, filename, raise_lines, nm)}
    if rec['k'] != 'timeout':
        rec = finish_rec(rec, nm, {})
    emit({'load': rec})
    if rec['k'] != 'value':
        emit({'hits': hits})
        return

    for ti, t in enumerate(plan):
        prev = []
        for ri, idx in enumerate(t['sched']):
            if time.monotonic() > deadline:
                emit({'budget': True})
                emit({'hits': hits})
                return
            init_args, args, kwargs = copy.deepcopy(t['inputs'][idx])
            out.clear()
            STUB_LOG.clear()
            nm = Norm()
            rec, res, obj = {}, None, None
            try:
                with Timer(call_timeout):
                    fn, obj = resolve(mod, t, init_args)
                    if t['kind'] == 'init':
                        res = obj
                    elif t['kind'] == 'property':
                        res = fn
                    else:
                        res = fn(*args, **kwargs)
                    if isinstance(res, types.CoroutineType):
                        res = drive(res)
                        rec['async'] = True
                    elif isinstance(res, types.GeneratorType):
                        items = []
                        for x in res:
                            items.append(x)
                            if len(items) >= 200:
                                break
                        res = Drained(items)
                rec['k'] = 'value'
            except CallTimeout:
                emit({'ti': ti, 'ri': ri, 'r': {'k': 'timeout'}})
                continue
            except BaseException as e:
                rec['k'] = 'throw'
                rec['e'] = exc_rec(e, filename, raise_lines, nm)
            ident = None
            if rec['k'] == 'value' and not isinstance(res, (int, float, str, bytes, bool, type(None), Drained)):
                ident = next((f'arg{i}' for i, a in enumerate(args) if res is a), None)
                if ident is None and obj is not None and res is obj and t['kind'] != 'init':
                    ident = 'self'
                if ident is None and any(res is p for p in prev):
                    ident = 'prev'
                if len(prev) < 50:
                    prev.append(res)
            rec['ident'] = ident
            extra = {'args': args, 'kw': kwargs, 'self': obj if t['kind'] != 'init' else None}
            if rec['k'] == 'value':
                extra['v'] = res
            emit({'ti': ti, 'ri': ri, 'r': finish_rec(rec, nm, extra)})
    emit({'hits': hits})


def run_side(code, filename, modname, raise_lines, plan, budget_s, workdir, call_timeout, n_probes):
    shutil.rmtree(workdir, ignore_errors=True)
    os.mkdir(workdir)
    r, w = os.pipe()
    deadline = time.monotonic() + budget_s
    pid = os.fork()
    if pid == 0:
        try:
            os.close(r)
            side_main(code, filename, modname, raise_lines, plan, deadline, w, workdir, call_timeout, n_probes)
        finally:
            os._exit(0)
    os.close(w)
    chunks, killed = [], False
    hard = deadline + call_timeout + 0.5
    while True:
        left = hard - time.monotonic()
        if left <= 0:
            killed = True
            break
        ready, _, _ = select.select([r], [], [], left)
        if not ready:
            continue
        b = os.read(r, 1 << 16)
        if not b:
            break
        chunks.append(b)
    if killed:
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
    os.close(r)
    os.waitpid(pid, 0)
    res = {'load': None, 'runs': {}, 'hits': None, 'budget': False, 'killed': killed}
    for line in b''.join(chunks).decode('utf-8', 'replace').splitlines():
        try:
            m = json.loads(line)
        except ValueError:
            continue
        if 'load' in m:
            res['load'] = m['load']
        elif 'ti' in m:
            res['runs'][(m['ti'], m['ri'])] = m['r']
        elif 'hits' in m:
            res['hits'] = m['hits']
        elif 'budget' in m:
            res['budget'] = True
    res['ended'] = res['hits'] is None and not res['budget'] and not killed
    return res


# --- comparison ---------------------------------------------------------------

REJECTS = {'TypeError', 'AttributeError'}
FIELDS = ('k', 'v', 'args', 'kw', 'self', 'ident', 'out', 'state', 'files', 'stubs', 'async')


def same(a, b):
    if any(not eq(a.get(f), b.get(f)) for f in FIELDS):
        return False
    if a['k'] == 'throw':
        ea, eb = a['e'], b['e']
        rejected = not ea['user'] and not eb['user'] and {ea['t'], eb['t']} <= REJECTS
        if ea['t'] != eb['t'] and not rejected:
            return False
        if (ea['user'] or eb['user']) and not eq(ea['args'], eb['args']):
            return False
    return True


def name_error(r):
    return r.get('k') == 'throw' and r['e']['t'] in ('NameError', 'UnboundLocalError')


def compare(a, b, a2, snippet):
    if a['k'] == 'timeout' or b['k'] == 'timeout' or (a2 and a2['k'] == 'timeout'):
        return 'timeout'
    if snippet and name_error(a) and name_error(b):
        return 'unresolved'
    if a2 is None or not same(a, a2):
        return 'nondet' if a2 is not None else 'differs'
    if same(a, b):
        return 'unresolved' if a.get('trunc') or b.get('trunc') else 'equal'
    if snippet and (name_error(a) or name_error(b)):
        return 'differs'
    if a.get('stub') or b.get('stub') or ((a.get('stubs') or b.get('stubs')) and not eq(a.get('stubs'), b.get('stubs'))):
        return 'differs'
    if a['k'] == 'throw' and not a['e']['user'] and a['e']['t'] in REJECTS:
        return 'ood'
    return 'mismatch'


def brief(r):
    if r is None:
        return None
    out = {'kind': r.get('k')}
    if r.get('k') == 'value':
        out['value'] = json.dumps(r.get('v'))[:300]
    if r.get('k') == 'throw':
        out['error'] = {'name': r['e']['t'], 'message': r['e']['msg']}
    if r.get('out'):
        out['stdout'] = r['out'][:300]
    return out


def show(v):
    try:
        return ADDR.sub('', repr(v))[:200]
    except Exception:
        return '<unrepresentable>'


# --- main ---------------------------------------------------------------------

# Children evaluated only sometimes when their parent is (plus the operands
# after the first of and/or).
COND_EXPR = {ast.IfExp: ('body', 'orelse'), ast.Lambda: ('body',), ast.Assert: ('msg',), ast.ListComp: ('elt',),
             ast.SetComp: ('elt',), ast.GeneratorExp: ('elt',), ast.DictComp: ('key', 'value'), ast.comprehension: ('ifs',)}


def probe(src, ranges, tree=None):
    """Probe each deleted range where it is evaluated: a __dt_hit__(k) line
    before its innermost statement, or `(__dt_hit__(k), e)[1]` around the
    conditionally evaluated expression holding it (COND_EXPR). The caller
    checks that the result compiles.
    -> (source, number of probes, every range probed)"""
    lines = src.splitlines(keepends=True)
    starts, at = [], 0
    for ln in lines:
        starts.append(at)
        at += len(ln)
    tree = tree or ast.parse(src)
    list_starts = {}

    encoded = {}

    def off(lineno, col):
        ln = lines[lineno - 1] if lineno - 1 < len(lines) else ''
        if ln.isascii():
            return starts[lineno - 1] + min(col, len(ln))
        if lineno not in encoded:
            encoded[lineno] = ln.encode('utf-8')
        return starts[lineno - 1] + len(encoded[lineno][:col].decode('utf-8', 'ignore'))

    spans, parts = {}, {}

    def span(n):
        key = id(n)
        if key not in spans:
            spans[key] = None if getattr(n, 'lineno', None) is None or getattr(n, 'end_lineno', None) is None \
                else (off(n.lineno, n.col_offset), off(n.end_lineno, n.end_col_offset))
        return spans[key]

    def holds(c, a, b):
        sp = span(c)
        if sp is None:  # no position (arguments, comprehension): any part holding it
            key = id(c)
            if key not in parts:
                parts[key] = [span(d) for d in ast.walk(c) if d is not c and span(d)]
            return any(x <= a and b <= y for x, y in parts[key])
        return sp[0] <= a and b <= sp[1]

    def candidates(value, a):
        # Siblings in a long list are disjoint and in source order: only the
        # last one starting at or before a can hold [a, b).
        if not isinstance(value, list):
            return [(0, value)]
        if len(value) < 16:
            return list(enumerate(value))
        key = id(value)
        if key not in list_starts:
            sp = [span(c) if isinstance(c, ast.AST) else None for c in value]
            st = [x[0] for x in sp] if all(sp) else None
            list_starts[key] = st if st and all(x <= y for x, y in zip(st, st[1:])) else None
        starts_ = list_starts[key]
        if starts_ is None:
            return list(enumerate(value))
        i = bisect.bisect_right(starts_, a) - 1
        return [(i, value[i])] if i >= 0 else []

    def site(a, b):
        node, found = tree, None
        while node is not None:
            nxt = None
            for field, value in ast.iter_fields(node):
                for i, c in candidates(value, a):
                    if not isinstance(c, ast.AST) or not holds(c, a, b):
                        continue
                    if isinstance(c, ast.stmt) and isinstance(value, list):
                        found = ('stmt', c)
                    elif (isinstance(node, ast.BoolOp) and i > 0) or field in COND_EXPR.get(type(node), ()):
                        found = ('expr', c)
                    nxt = c
                    break
                if nxt is not None:
                    break
            node = nxt
        return found

    sites = {}
    for a, b in ranges:
        s = site(a, b)
        if s is None:
            return src, 0, False
        sites[id(s[1])] = s
    edits = []
    for k, (kind, n) in enumerate(sites.values()):
        if kind == 'stmt':
            first = min([n] + list(getattr(n, 'decorator_list', [])), key=lambda d: (d.lineno, d.col_offset))
            text = lines[first.lineno - 1]
            indent = text[:len(text) - len(text.lstrip())]
            if first.col_offset != len(indent.encode()):
                return src, 0, False
            edits.append((starts[first.lineno - 1], 0, 0, f'{indent}__dt_hit__({k})\n'))
        else:
            a, b = span(n)
            edits.append((a, 0, a - b, f'(__dt_hit__({k}), '))
            edits.append((b, 1, a - b, ')[1]'))
    # As if inserted right to left (at one offset openers before closers,
    # inner first), in one pass.
    order = sorted(edits, key=lambda e: (-e[0], e[1], -e[2] if e[1] == 0 else e[2]))
    pieces, prev = [], 0
    for at, _, _, text in reversed(order):
        pieces += [src[prev:at], text]
        prev = at
    pieces.append(src[prev:])
    return ''.join(pieces), len(sites), True


def raise_lines(tree, src):
    """Lines of every `raise` statement; only top-level statements whose
    lines mention `raise` are walked."""
    marked = [i + 1 for i, ln in enumerate(re.split(r'\r\n?|\n', src)) if 'raise' in ln]
    out = set()
    for s in tree.body if marked else ():
        lo = min([s.lineno] + [d.lineno for d in getattr(s, 'decorator_list', [])])
        k = bisect.bisect_left(marked, lo)
        if k == len(marked) or marked[k] > (s.end_lineno or s.lineno):
            continue
        for n in ast.walk(s):
            if isinstance(n, ast.Raise):
                out.update(range(n.lineno, (n.end_lineno or n.lineno) + 1))
    return out


def edit_lines(a, b):
    """1-based line spans of the text that differs between a and b, in each."""
    n = min(len(a), len(b))
    lo, hi = 0, n
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if a[:mid] == b[:mid]:
            lo = mid
        else:
            hi = mid - 1
    p = lo
    lo, hi = 0, n - p
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if a[len(a) - mid:] == b[len(b) - mid:]:
            lo = mid
        else:
            hi = mid - 1
    nl = lambda s, i, j: s.count('\n', i, j) + s.count('\r', i, j) - s.count('\r\n', i, j)
    out = []
    for s in (a, b):
        first = nl(s, 0, p) + 1
        out.append((first - 1, first + nl(s, p, len(s) - lo) + 1))  # one line of slack each way (\r|\n split)
    return out


def touches(node, lo, hi):
    first = min([node.lineno] + [d.lineno for d in getattr(node, 'decorator_list', [])])
    return first <= hi and (node.end_lineno or node.lineno) >= lo


def set_parents(tree):
    for n in ast.walk(tree):
        for c in ast.iter_child_nodes(n):
            c._p = n


PLAN = []


def main(req):
    t0 = time.monotonic()
    cur_src, prop_src = req['current'], req['proposed']
    snippet = bool(req.get('snippet'))
    modname = req.get('modname') or '__dt_mod__'
    budget = req.get('budget_ms', 1500) / 1000.0
    call_timeout = req.get('call_timeout_ms', 250) / 1000.0
    try:
        cur_tree = ast.parse(cur_src)
    except SyntaxError as e:
        return {'verdict': 'inconclusive', 'runs': 0, 'reason': f'current does not parse: {e.msg} (line {e.lineno})'}
    try:
        prop_tree = ast.parse(prop_src)
    except SyntaxError as e:
        return {'verdict': 'divergent', 'runs': 0, 'reason': f'proposed does not parse: {e.msg} (line {e.lineno})',
                'counterexample': {'phase': 'load', 'proposed': {'kind': 'throw', 'error': {'name': 'SyntaxError', 'message': e.msg}}}}
    cf, cv, co = layout(cur_tree)
    pf, pv, po = layout(prop_tree)
    caps = []
    # A callable outside the lines that differ is the same text on both sides.
    (c1, c2), (p1, p2) = edit_lines(cur_src, prop_src)
    changed = [q for q in cf if q in pf and (touches(cf[q][1], c1, c2) or touches(pf[q][1], p1, p2))
               and dump(cf[q][1]) != dump(pf[q][1])]
    removed = [q for q in cf if q not in pf and not q.split('.')[-1].startswith('_')]
    if removed:
        caps.append(f'callable(s) removed by the edit: {", ".join(removed)}')
    kind_changed = [q for q in changed if cf[q][0] != pf[q][0]]
    if kind_changed:
        caps.append(f'callable kind changed: {", ".join(kind_changed)}')
    values = [k for k in set(cv) | set(pv) if cv.get(k) != pv.get(k)]
    if sorted(co) != sorted(po):
        caps.append('a top-level statement outside a located callable changed')
    if len(changed) > MAX_TARGETS:
        caps.append(f'{len(changed) - MAX_TARGETS} changed callable(s) beyond the {MAX_TARGETS}-target cap were not tested')
        changed = changed[:MAX_TARGETS]
    nd = set()
    for q in changed:
        a, b = names_in(cf[q][1]) & NONDET, names_in(pf[q][1]) & NONDET
        nd |= a ^ b
    if nd:
        caps.append(f'the edit changes references to the clock, randomness or environment ({", ".join(sorted(nd))})')
    if not changed and not values:
        reason = '; '.join(['no callable function or constant located in the edit'] + caps)
        return {'verdict': 'inconclusive', 'runs': 0, 'reason': reason}

    small = len(cur_src) < 20000
    for node in [cur_tree, prop_tree] if small else [cf[q][2] or cf[q][1] for q in changed] + [pf[q][1] for q in changed]:
        set_parents(node)
    lits = literals([cur_tree, prop_tree] if small else [cf[q][1] for q in changed] + [pf[q][1] for q in changed])
    P = pools_from(lits)
    rng = random.Random(SEED)
    plan = []
    for q in changed:
        kind, fn, cls = cf[q]
        if kind in ('method', 'property', 'init'):
            init = next((m for m in cls.body if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef)) and m.name == '__init__'), None)
            if init is not None:
                attr_map = {}
                for n in ast.walk(init):
                    if isinstance(n, ast.Assign) and isinstance(n.value, ast.Name):
                        for tg in n.targets:
                            if isinstance(tg, ast.Attribute) and isinstance(tg.value, ast.Name) and tg.value.id == 'self':
                                attr_map[tg.attr] = n.value.id
                ih = analyze(init, signature(init, True)[0] + [n for n, _ in signature(init, True)[2]])
                for m in cls.body:
                    if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef)) and m is not init and attr_map:
                        for p, h in analyze(m, [], attr_map).items():
                            ih.setdefault(p, Hint()).kinds |= h.kinds
                inits = build_inputs(init, True, ih, P, rng)
            else:
                inits = [((), {})]
            if kind == 'init':
                inputs = [(a, (), {}) for a, kw in inits if not kw]
            elif kind == 'property':
                inputs = [(a, (), {}) for a, kw in inits if not kw]
            else:
                pos, _, kwonly, _ = signature(fn, True)
                own = build_inputs(fn, True, analyze(fn, pos + [n for n, _ in kwonly]), P, rng)
                m = max(len(own), min(len(inits), MAX_INPUTS))
                inputs = [(inits[i % len(inits)][0],) + own[i % len(own)] for i in range(m)]
        else:
            skip = kind == 'classmethod'
            pos, _, kwonly, _ = signature(fn, skip)
            inputs = [((), a, kw) for a, kw in build_inputs(fn, skip, analyze(fn, pos + [n for n, _ in kwonly]), P, rng)]
        inputs = inputs or [((), (), {})]
        n = len(inputs)
        sched = []
        while len(sched) < max(2 * n, MIN_VALUE_RUNS) and len(sched) < MAX_RUNS:
            sched.extend(range(n))
        sched = sched[:max(MAX_RUNS, n)]
        name = fn.name
        plan.append({'label': q, 'kind': kind, 'name': name, 'cls': cls.name if cls is not None else None,
                     'inputs': inputs, 'sched': sched, 'arity': len(signature(fn, kind in ('method', 'property', 'init', 'classmethod'))[0])})
    PLAN[:] = plan

    probed, probed_tree, n_probes, probes_ok = cur_src, cur_tree, 0, True
    deleted = req.get('deleted') or []
    if deleted:
        try:
            out, n, ok = probe(cur_src, deleted, cur_tree)
            if n:
                probed, probed_tree, n_probes, probes_ok = out, ast.parse(out), n, ok
            else:
                probes_ok = ok
        except Exception:
            probes_ok = False

    root = req.get('workdir') or os.getcwd()
    workdir = os.path.join(root, 'cwd')
    filename = os.path.join(workdir, req.get('basename') or 'module.py')

    def compiled(tree, src):
        # Compiled once here and inherited by the forked sides; a compile-time
        # error is left for the side to report as a load failure.
        try:
            return compile(tree, filename, 'exec')
        except Exception:
            return src

    cur_code = compiled(probed_tree, probed)
    if n_probes and isinstance(cur_code, str):
        probed, probed_tree, n_probes, probes_ok = cur_src, cur_tree, 0, False
        cur_code = compiled(cur_tree, cur_src)
    cur_raise = raise_lines(probed_tree, probed)
    side_args = ((cur_code, cur_raise), (compiled(prop_tree, prop_src), raise_lines(prop_tree, prop_src)), (cur_code, cur_raise))
    sides = []
    for i, (code, rl) in enumerate(side_args):
        share = max(0.05, (budget - (time.monotonic() - t0)) / (3 - i))
        sides.append(run_side(code, filename, modname, rl, plan, share, workdir, call_timeout, n_probes))
    A, B, A2 = sides
    shutil.rmtree(workdir, ignore_errors=True)

    la, lb, la2 = A['load'], B['load'], A2['load']
    if la is None or lb is None:
        return {'verdict': 'inconclusive', 'runs': 0, 'reason': 'a sandboxed side ended before loading the module'}
    if la['k'] != 'value':
        what = la['e']['t'] + ': ' + la['e']['msg'] if la['k'] == 'throw' else la['k']
        return {'verdict': 'inconclusive', 'runs': 0, 'reason': f'current failed to load: {what}'}
    if lb['k'] != 'value':
        if lb['k'] == 'timeout' or (snippet and name_error(lb)) or lb.get('stub'):
            return {'verdict': 'inconclusive', 'runs': 0, 'reason': f'proposed failed to load ({lb["k"]})'}
        return {'verdict': 'divergent', 'runs': 0, 'reason': f'proposed failed to load: {lb["e"]["t"]}: {lb["e"]["msg"]}',
                'counterexample': {'phase': 'load', 'proposed': brief(lb)}}
    notes = []
    inconclusive = bool(caps)
    runs = 0
    if values:
        runs = 1
    if la2 is None or la2['k'] == 'timeout':
        inconclusive = True
        notes.append('time budget reached before the second current run loaded the module' if la2 is None and (A2['killed'] or A2['budget'])
                     else 'the second current run timed out loading the module' if la2 is not None
                     else 'the second current run ended before loading the module')
    elif not same(la, la2):
        inconclusive = True
        notes.append('module state after load is not deterministic')
    elif not same(la, lb):
        if la.get('stub') or lb.get('stub') or not eq(la.get('stubs'), lb.get('stubs')):
            inconclusive = True
            notes.append('module-scope state after load differs through dependency stubs')
        else:
            return {'verdict': 'divergent', 'runs': 1, 'reason': 'module-scope state differs after load',
                    'counterexample': {'phase': 'load', 'current': brief(la), 'proposed': brief(lb)}}

    for ti, t in enumerate(plan):
        sched = t['sched']
        distinct_n = len(t['inputs'])
        need_distinct = min(MIN_VALUE_RUNS, max(math.ceil(distinct_n / 5), min(3, distinct_n)))
        value = thrown = differs = ood = nondet = unres = n = 0
        valued = set()
        for ri, idx in enumerate(sched):
            a, b, a2 = A['runs'].get((ti, ri)), B['runs'].get((ti, ri)), A2['runs'].get((ti, ri))
            if a is None or b is None or a2 is None:
                break
            n += 1
            runs += 1
            c = compare(a, b, a2, snippet)
            if c == 'timeout':
                who = 'proposed side' if b['k'] == 'timeout' and a['k'] != 'timeout' else 'current side' if b['k'] != 'timeout' else 'both sides'
                return {'verdict': 'inconclusive', 'runs': runs, 'reason': f'{who} exceeded the {round(call_timeout * 1000)} ms per-call timeout on {t["label"]}'}
            if c == 'mismatch':
                init_args, args, kw = t['inputs'][idx]
                return {'verdict': 'divergent', 'runs': runs,
                        'reason': f'{t["label"]}: {"outputs differ" if not eq(a.get("v"), b.get("v")) or a["k"] != b["k"] else "side effects differ"}',
                        'counterexample': {'target': t['label'], 'index': idx, 'run': ri, 'args': [show(x) for x in args],
                                           'kwargs': {k: show(v) for k, v in kw.items()}, 'init': [show(x) for x in init_args],
                                           'current': brief(a), 'proposed': brief(b)}}
            if c == 'equal':
                if a['k'] == 'value':
                    value += 1
                    valued.add(idx)
                else:
                    thrown += 1
            elif c == 'differs':
                differs += 1
            elif c == 'ood':
                ood += 1
            elif c == 'nondet':
                nondet += 1
            else:
                unres += 1
        if value >= MIN_VALUE_RUNS and len(valued) >= need_distinct and not (differs or ood or nondet) and n == len(sched):
            continue
        inconclusive = True
        lab = t['label']
        if nondet:
            notes.append(f'{lab}: the current version is not deterministic on {nondet} of {n} runs')
        elif differs:
            notes.append(f'{lab}: {differs} of {n} runs differ only through dependency stubs or missing snippet context')
        elif ood:
            notes.append(f'{lab}: {ood} of {n} runs differ only on inputs the current version rejects with a TypeError/AttributeError (outside its domain)')
        elif n < len(sched) and any(x['ended'] for x in sides):
            notes.append(f'{lab}: a sandboxed side ended early (exit, crash or resource limit) after {n} of {len(sched)} runs')
        elif n < len(sched):
            notes.append(f'{lab}: time budget reached after {n} of {len(sched)} runs')
        elif unres == n:
            notes.append(f'{lab}: both sides hit unresolved names on every input (missing context; pass fileSrc)')
        elif thrown == n:
            notes.append(f'{lab}: both sides threw on every input ({n} runs)')
        else:
            notes.append(f'{lab}: only {value} of {n} runs returned comparable values on both sides ({len(valued)} of {distinct_n} inputs; need {need_distinct} inputs, {MIN_VALUE_RUNS} runs)')
    res = {'runs': runs}
    if inconclusive:
        res.update(verdict='inconclusive', reason='; '.join(notes + caps) or 'inconclusive')
    else:
        res['verdict'] = 'equivalent'
        if deleted:
            hits = A['hits'] or []
            res['deletions_observed'] = probes_ok and n_probes > 0 and len(hits) == n_probes and all(h > 0 for h in hits)
    return res


def finite(v):
    if isinstance(v, float) and not math.isfinite(v):
        return str(v)
    if isinstance(v, dict):
        return {k: finite(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [finite(x) for x in v]
    return v


if __name__ == '__main__':
    sys.dont_write_bytecode = True
    if hasattr(sys, 'set_int_max_str_digits'):
        sys.set_int_max_str_digits(0)
    try:
        resource.setrlimit(resource.RLIMIT_AS, (MEM_BYTES, MEM_BYTES))
    except (ValueError, OSError):
        pass
    try:
        out = main(json.loads(sys.stdin.read()))
        out['function_name'] = ', '.join(t['label'] for t in PLAN)
        out['arity'] = PLAN[0]['arity'] if PLAN else 0
    except Exception as e:
        out = {'verdict': 'inconclusive', 'runs': 0, 'reason': f'harness error: {type(e).__name__}: {e}'}
    sys.stdout.write(json.dumps(finite(out), allow_nan=False) + '\n')
    sys.stdout.flush()
