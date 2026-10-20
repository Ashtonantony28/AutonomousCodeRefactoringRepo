'use strict';

// Lightweight multi-language structural checks for the four anti-patterns
// when @babel can't parse the file. Each language adapter exposes:
//   parse(src) -> { functions: [{name, params, start, end, hasReturn, alwaysReturns, ...}],
//                   imports: [string], localImports: [string], tryCount: number }
// Sources are first run through stripCode() so string and comment contents
// never count as code. Scanning is lexical (balanced brackets + indentation),
// not a full parser: tree-sitter would be strictly better but needs native builds.

const fs = require('fs');
const path = require('path');

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ---------- Lexical helpers ----------

// Blank out the contents of comments and string literals (keeping quotes,
// newlines and length) so offsets still line up with the original source.
// `keepStrings` blanks comments only.
function stripCode(src, lang, { keepStrings = false } = {}) {
  if (!src) return '';
  const out = src.split('');
  const n = src.length;
  const blank = (a, b) => { for (let k = a; k < b && k < n; k++) if (out[k] !== '\n') out[k] = ' '; };
  const lineComment = lang === 'python' || lang === 'ruby' ? '#' : '//';
  const blockComments = lang === 'javascript' || lang === 'go';
  const quotes = lang === 'go' ? '"\'`' : lang === 'javascript' ? '"\'`' : '"\'';
  let i = 0;
  while (i < n) {
    const ch = src[i];
    if (src.startsWith(lineComment, i)) {
      let j = src.indexOf('\n', i);
      if (j < 0) j = n;
      blank(i, j);
      i = j;
    } else if (blockComments && src.startsWith('/*', i)) {
      let j = src.indexOf('*/', i + 2);
      j = j < 0 ? n : j + 2;
      blank(i, j);
      i = j;
    } else if (lang === 'ruby' && src.startsWith('=begin', i) && (i === 0 || src[i - 1] === '\n')) {
      let j = src.indexOf('\n=end', i);
      j = j < 0 ? n : j + 5;
      blank(i, j);
      i = j;
    } else if (lang === 'python' && (src.startsWith('"""', i) || src.startsWith("'''", i))) {
      const q = src.slice(i, i + 3);
      let j = i + 3;
      while (j < n && !src.startsWith(q, j)) j += src[j] === '\\' ? 2 : 1;
      if (!keepStrings) blank(i + 3, j);
      i = Math.min(n, j + 3);
    } else if (quotes.includes(ch)) {
      let j = i + 1;
      const raw = lang === 'go' && ch === '`';
      const multiline = ch === '`';
      while (j < n && src[j] !== ch) {
        if (!raw && src[j] === '\\') j++;
        else if (!multiline && src[j] === '\n') break;
        j++;
      }
      if (!keepStrings) blank(i + 1, j);
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join('');
}

const OPEN = { '(': ')', '[': ']', '{': '}' };

// Index of the bracket closing the one at `openIdx` (on stripped source), or -1.
function matchBracket(s, openIdx) {
  const stack = [];
  for (let i = openIdx; i < s.length; i++) {
    const c = s[i];
    if (OPEN[c]) stack.push(OPEN[c]);
    else if (c === ')' || c === ']' || c === '}') {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

// Split on commas at bracket depth 0.
function splitTopLevel(s) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const c of s) {
    if (OPEN[c]) depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += c;
  }
  parts.push(cur);
  return parts.map(p => p.trim()).filter(Boolean);
}

function skipWs(s, i) { while (i < s.length && /\s/.test(s[i])) i++; return i; }

// ---------- Python ----------

// Bare `*` and `/` are keyword-only / positional-only markers, not params.
function pyParamCount(inner) {
  return splitTopLevel(inner).filter(p => p !== '*' && p !== '/').length;
}

function parsePython(src) {
  const s = stripCode(src, 'python');
  const out = { functions: [], imports: [], localImports: [], tryCount: 0 };
  const defRe = /^([ \t]*)(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)[ \t]*(?=[([])/gm;
  let m;
  const defs = [];
  while ((m = defRe.exec(s))) {
    let open = m.index + m[0].length;
    if (s[open] === '[') { const c = matchBracket(s, open); if (c < 0) continue; open = skipWs(s, c + 1); }
    if (s[open] !== '(') continue;
    const close = matchBracket(s, open);
    if (close < 0) continue;
    const colon = s.indexOf(':', close);
    if (colon < 0) continue;
    defs.push({ indent: m[1].replace(/\t/g, '    ').length, name: m[2], start: m.index, sigEnd: colon + 1, params: pyParamCount(s.slice(open + 1, close)) });
  }
  for (const d of defs) {
    // Body: the rest of the colon line plus following lines indented deeper than the def.
    let end = s.indexOf('\n', d.sigEnd);
    const bodyLines = [];
    const sameLine = s.slice(d.sigEnd, end < 0 ? s.length : end).trim();
    if (sameLine) bodyLines.push({ indent: d.indent + 1, text: sameLine });
    if (end < 0) end = s.length;
    let pos = end;
    while (pos < s.length) {
      const next = s.indexOf('\n', pos + 1);
      const lineEnd = next < 0 ? s.length : next;
      const line = s.slice(pos + 1, lineEnd);
      if (line.trim()) {
        const indent = line.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length;
        if (indent <= d.indent) break;
        bodyLines.push({ indent, text: line.trim() });
        end = lineEnd;
      }
      pos = lineEnd;
      if (next < 0) break;
    }
    // Ignore returns inside nested defs/classes.
    let hasReturn = false;
    let nestedIndent = null;
    let bodyIndent = null;
    let last = null;
    for (const l of bodyLines) {
      if (nestedIndent !== null) { if (l.indent > nestedIndent) continue; nestedIndent = null; }
      if (/^(async\s+)?def\s|^class\s/.test(l.text)) { nestedIndent = l.indent; continue; }
      if (bodyIndent === null) bodyIndent = l.indent;
      if (/^return\s+\S/.test(l.text) || /^raise\b/.test(l.text)) hasReturn = true;
      if (l.indent === bodyIndent) last = l.text;
    }
    const alwaysReturns = !!last && /^(return\s+\S|raise\b)/.test(last);
    out.functions.push({ name: d.name, params: d.params, start: d.start, end, hasReturn, alwaysReturns });
  }

  const importRe = /^[ \t]*import[ \t]+([^\n;]+)/gm;
  while ((m = importRe.exec(s))) {
    for (const part of m[1].split(',')) {
      const mod = part.trim().split(/\s+/)[0];
      if (/^[A-Za-z_][\w.]*$/.test(mod)) out.imports.push(mod.split('.')[0]);
    }
  }
  const fromRe = /^[ \t]*from[ \t]+(\.*)([A-Za-z_][\w.]*)?[ \t]+import\b/gm;
  while ((m = fromRe.exec(s))) {
    if (m[1]) { if (m[2]) out.localImports.push(m[2].split('.')[0]); continue; }
    if (m[2]) out.imports.push(m[2].split('.')[0]);
  }
  out.tryCount = (s.match(/^[ \t]*try[ \t]*:/gm) || []).length;
  return out;
}

// sys.stdlib_module_names (3.12) minus private/test-only modules.
const PYTHON_STDLIB = new Set(('__future__ abc aifc argparse array ast asynchat asyncio asyncore atexit audioop base64 bdb binascii '
  + 'bisect builtins bz2 cProfile calendar cgi cgitb chunk cmath cmd code codecs codeop collections colorsys compileall '
  + 'concurrent configparser contextlib contextvars copy copyreg crypt csv ctypes curses dataclasses datetime dbm decimal '
  + 'difflib dis distutils doctest email encodings ensurepip enum errno faulthandler fcntl filecmp fileinput fnmatch '
  + 'fractions ftplib functools gc getopt getpass gettext glob graphlib grp gzip hashlib heapq hmac html http idlelib '
  + 'imaplib imghdr imp importlib inspect io ipaddress itertools json keyword lib2to3 linecache locale logging lzma '
  + 'mailbox mailcap marshal math mimetypes mmap modulefinder msilib msvcrt multiprocessing netrc nis nntplib nt ntpath '
  + 'nturl2path numbers opcode operator optparse os ossaudiodev pathlib pdb pickle pickletools pipes pkgutil platform '
  + 'plistlib poplib posix posixpath pprint profile pstats pty pwd py_compile pyclbr pydoc pydoc_data pyexpat queue '
  + 'quopri random re readline reprlib resource rlcompleter runpy sched secrets select selectors shelve shlex shutil '
  + 'signal site smtpd smtplib sndhdr socket socketserver spwd sqlite3 sre_compile sre_constants sre_parse ssl stat '
  + 'statistics string stringprep struct subprocess sunau symtable sys sysconfig syslog tabnanny tarfile telnetlib '
  + 'tempfile termios textwrap this threading time timeit tkinter token tokenize tomllib trace traceback tracemalloc '
  + 'tty turtle turtledemo types typing unicodedata unittest urllib uu uuid venv warnings wave weakref webbrowser '
  + 'winreg winsound wsgiref xdrlib xml xmlrpc zipapp zipfile zipimport zlib zoneinfo _thread').split(/\s+/));

// Distribution name → import name, for the common mismatches.
const PY_DIST_ALIASES = {
  pyyaml: 'yaml', beautifulsoup4: 'bs4', pillow: 'PIL', 'scikit-learn': 'sklearn', 'python-dateutil': 'dateutil',
  'opencv-python': 'cv2', protobuf: 'google', 'python-dotenv': 'dotenv', pyjwt: 'jwt', 'attrs': 'attr'
};

function normPy(name) { return name.toLowerCase().replace(/[-.]/g, '_'); }

function pythonDeclaredDeps(repoRoot) {
  const out = new Set();
  if (!repoRoot) return out;
  const add = (spec) => {
    const m = String(spec).trim().match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
    if (!m) return;
    const dist = m[1].toLowerCase();
    out.add(normPy(dist));
    if (PY_DIST_ALIASES[dist]) out.add(normPy(PY_DIST_ALIASES[dist]));
  };
  let names = [];
  try { names = fs.readdirSync(repoRoot); } catch { /* */ }
  for (const f of names.filter(n => /^requirements.*\.txt$/i.test(n))) {
    const txt = safeRead(path.join(repoRoot, f)) || '';
    for (const line of txt.split('\n')) {
      const l = line.replace(/#.*/, '').trim();
      if (l && !l.startsWith('-')) add(l);
    }
  }
  const pyproject = safeRead(path.join(repoRoot, 'pyproject.toml'));
  if (pyproject) {
    const arrRe = /^\s*(?:dependencies|requires|[A-Za-z0-9_-]+)\s*=\s*\[([\s\S]*?)\]/gm;
    let m;
    while ((m = arrRe.exec(pyproject))) {
      const strRe = /["']([^"']+)["']/g;
      let s;
      while ((s = strRe.exec(m[1]))) add(s[1]);
    }
    const sectionRe = /^\[tool\.poetry\.(?:[\w.-]*dependencies)\]\s*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/gm;
    while ((m = sectionRe.exec(pyproject))) {
      for (const line of m[1].split('\n')) { const k = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=/); if (k) add(k[1]); }
    }
  }
  return out;
}

function pythonLocalModule(repoRoot, name) {
  if (!repoRoot) return false;
  for (const base of ['', 'src']) {
    const dir = path.join(repoRoot, base);
    if (fs.existsSync(path.join(dir, `${name}.py`)) || fs.existsSync(path.join(dir, name))) return true;
  }
  return false;
}

// ---------- Go ----------

function parseGo(src) {
  const s = stripCode(src, 'go');
  const out = { functions: [], imports: [], localImports: [], tryCount: 0 };
  const funcRe = /\bfunc\b/g;
  let m;
  while ((m = funcRe.exec(s))) {
    let i = skipWs(s, m.index + 4);
    if (s[i] === '(') { // receiver
      const c = matchBracket(s, i);
      if (c < 0) continue;
      i = skipWs(s, c + 1);
    }
    const nm = /^[A-Za-z_]\w*/.exec(s.slice(i, i + 200));
    if (!nm) continue;
    i = skipWs(s, i + nm[0].length);
    if (s[i] === '[') { const c = matchBracket(s, i); if (c < 0) continue; i = skipWs(s, c + 1); }
    if (s[i] !== '(') continue;
    const pClose = matchBracket(s, i);
    if (pClose < 0) continue;
    const params = goParamCount(s.slice(i + 1, pClose));
    const bodyOpen = findGoBodyOpen(s, pClose + 1);
    if (bodyOpen < 0) continue;
    const results = s.slice(pClose + 1, bodyOpen).trim();
    const bodyClose = matchBracket(s, bodyOpen);
    const body = s.slice(bodyOpen + 1, bodyClose < 0 ? s.length : bodyClose);
    const resultCount = !results ? 0 : results.startsWith('(') ? splitTopLevel(results.slice(1, -1)).length : 1;
    const returnCount = (body.match(/\breturn\b/g) || []).length;
    const panics = /\b(?:panic|log\.Fatal\w*|os\.Exit)\s*\(/.test(body);
    out.functions.push({
      name: nm[0], params, start: m.index, end: bodyClose < 0 ? s.length : bodyClose + 1,
      results, resultCount, returnCount, panics,
      hasReturn: resultCount > 0, alwaysReturns: resultCount > 0 && (returnCount > 0 || panics)
    });
  }
  const impSingle = /^\s*import\s+(?:[A-Za-z_.]\w*\s+)?"([^"]*)"/gm;
  const raw = src;
  while ((m = impSingle.exec(raw))) out.imports.push(m[1]);
  const impBlock = /^\s*import\s*\(([\s\S]*?)\)/gm;
  while ((m = impBlock.exec(raw))) {
    const lineRe = /"([^"]+)"/g;
    let mm;
    while ((mm = lineRe.exec(m[1]))) out.imports.push(mm[1]);
  }
  // Go has no try/catch; `if err != nil` blocks are the analog.
  out.tryCount = (s.match(/\bif\b[^{\n]*\berr\s*!=\s*nil\b/g) || []).length;
  return out;
}

// `a, b int` declares two params; `int, string` (unnamed) also counts two.
function goParamCount(inner) {
  return splitTopLevel(inner).length;
}

// Find the `{` that opens a func body after the params (skipping brackets in result types).
function findGoBodyOpen(s, i) {
  while (i < s.length) {
    const c = s[i];
    if (c === '{') {
      // `interface{}` / `struct{...}` in a result type are not the body.
      const before = s.slice(Math.max(0, i - 9), i);
      if (/(?:interface|struct)\s*$/.test(before)) { const e = matchBracket(s, i); if (e < 0) return -1; i = e + 1; continue; }
      return i;
    }
    if (c === '(' || c === '[') { const e = matchBracket(s, i); if (e < 0) return -1; i = e + 1; continue; }
    if (c === '\n') return -1; // declaration without body (e.g. assembly stub)
    i++;
  }
  return -1;
}

function goModInfo(repoRoot) {
  const txt = repoRoot ? safeRead(path.join(repoRoot, 'go.mod')) : null;
  const out = { module: null, requires: [] };
  if (!txt) return out;
  const mod = txt.match(/^\s*module\s+(\S+)/m);
  if (mod) out.module = mod[1];
  const block = /^\s*require\s*\(([\s\S]*?)\)/gm;
  let m;
  while ((m = block.exec(txt))) for (const line of m[1].split('\n')) { const p = line.trim().split(/\s+/)[0]; if (p && !p.startsWith('//')) out.requires.push(p); }
  const single = /^\s*require\s+([^\s(]+)/gm;
  while ((m = single.exec(txt))) out.requires.push(m[1]);
  return out;
}

// ---------- Ruby ----------

const RUBY_STDLIB = new Set(('abbrev base64 benchmark bigdecimal cgi csv date delegate digest English erb etc fcntl fiddle '
  + 'fileutils find forwardable getoptlong io/console ipaddr irb json logger matrix monitor net/http net/https '
  + 'objspace observer open3 open-uri openssl optparse ostruct pathname pp prettyprint prime pstore psych racc rdoc '
  + 'readline resolv ripper securerandom set shellwords singleton socket stringio strscan syslog tempfile time '
  + 'timeout tmpdir tsort un uri weakref yaml zlib coverage rbconfig').split(/\s+/));

function parseRuby(src) {
  const s = stripCode(src, 'ruby');
  const out = { functions: [], imports: [], localImports: [], tryCount: 0 };
  const fnRe = /^[ \t]*def[ \t]+(?:self\.)?([A-Za-z_]\w*[!?=]?)[ \t]*(\()?/gm;
  let m;
  while ((m = fnRe.exec(s))) {
    let params = 0;
    if (m[2]) {
      const open = m.index + m[0].length - 1;
      const close = matchBracket(s, open);
      if (close > 0) params = splitTopLevel(s.slice(open + 1, close)).length;
    } else {
      const rest = s.slice(m.index + m[0].length, s.indexOf('\n', m.index) < 0 ? s.length : s.indexOf('\n', m.index)).trim();
      if (rest && !rest.startsWith(';')) params = splitTopLevel(rest.split(';')[0]).length;
    }
    out.functions.push({ name: m[1], params, start: m.index, end: m.index + m[0].length, hasReturn: true, alwaysReturns: true });
  }
  const reqRe = /\b(require|require_relative)\s*\(?\s*['"]([^'"]+)['"]/g;
  while ((m = reqRe.exec(src))) (m[1] === 'require' ? out.imports : out.localImports).push(m[2]);
  out.tryCount = (s.match(/\brescue\b/g) || []).length;
  return out;
}

function gemfileDeps(repoRoot) {
  const txt = repoRoot ? safeRead(path.join(repoRoot, 'Gemfile')) : null;
  const out = new Set();
  if (!txt) return out;
  const re = /^\s*gem\s+['"]([^'"]+)['"]/gm;
  let m;
  while ((m = re.exec(txt))) out.add(m[1]);
  return out;
}

// ---------- Dispatcher ----------

const EXTENSIONS = { python: /\.py$/i, go: /\.go$/i, ruby: /\.rb$/i };

function languageOf(file) {
  for (const [lang, re] of Object.entries(EXTENSIONS)) if (re.test(file)) return lang;
  return null;
}

function parse(file, src) {
  const lang = languageOf(file);
  if (!lang) return null;
  if (lang === 'python') return { lang, ...parsePython(src) };
  if (lang === 'go') return { lang, ...parseGo(src) };
  if (lang === 'ruby') return { lang, ...parseRuby(src) };
  return null;
}

function isExternalImport(name, lang, repoRoot) {
  if (!name) return false;
  if (lang === 'python') {
    if (name.startsWith('.') || PYTHON_STDLIB.has(name)) return false;
    return !pythonLocalModule(repoRoot, name);
  }
  if (lang === 'go') {
    // stdlib paths have no '.' in their first element
    if (!name.split('/')[0].includes('.')) return false;
    const mod = goModInfo(repoRoot).module;
    return !(mod && (name === mod || name.startsWith(mod + '/')));
  }
  if (lang === 'ruby') {
    if (name.startsWith('.') || name.startsWith('/') || RUBY_STDLIB.has(name)) return false;
    return true;
  }
  return false;
}

function isDeclared(name, lang, repoRoot) {
  if (lang === 'python') return pythonDeclaredDeps(repoRoot).has(normPy(name));
  if (lang === 'go') return goModInfo(repoRoot).requires.some(r => name === r || name.startsWith(r + '/'));
  if (lang === 'ruby') return gemfileDeps(repoRoot).has(name.split('/')[0]);
  return false;
}

// ---------- Region / pairing helpers ----------

function inRegion(fn, region, side) {
  if (!region) return true;
  const end = side === 'current' ? region.endCurrent : region.endProposed;
  return fn.start < Math.max(end, region.start + 1) && fn.end > region.start;
}

// Key functions by name + occurrence index so same-named defs don't collide.
function keyed(fns) {
  const seen = new Map();
  const out = new Map();
  for (const f of fns) {
    const i = seen.get(f.name) || 0;
    seen.set(f.name, i + 1);
    out.set(`${f.name}#${i}`, f);
  }
  return out;
}

function pairFunctions(before, after, region) {
  const b = keyed(before.functions.filter(f => inRegion(f, region, 'current')));
  const a = keyed(after.functions.filter(f => inRegion(f, region, 'proposed')));
  const pairs = [];
  const removed = [];
  for (const [k, f] of b) {
    if (a.has(k)) pairs.push([f, a.get(k)]);
    else if (!after.functions.some(x => x.name === f.name)) removed.push(f);
  }
  const added = [...a.values()].filter(f => !before.functions.some(x => x.name === f.name));
  return { pairs, removed, added };
}

// ---------- Checks ----------

const DEF_PATTERNS = {
  python: (n) => new RegExp(`\\bdef\\s+${escapeRe(n)}\\b`, 'g'),
  go: (n) => new RegExp(`\\bfunc\\s+(?:\\([^)]*\\)\\s*)?${escapeRe(n)}\\b`, 'g'),
  ruby: (n) => new RegExp(`\\bdef\\s+(?:self\\.)?${escapeRe(n)}(?![\\w!?=])`, 'g')
};

function countCallSites(src, lang, name, exclude, s = stripCode(src, lang)) {
  const defs = new Set();
  let m;
  const defRe = DEF_PATTERNS[lang](name);
  while ((m = defRe.exec(s))) defs.add(m.index + m[0].length - name.length);
  const callRe = lang === 'ruby'
    ? new RegExp(`(?<![\\w@$:])${escapeRe(name)}(?![\\w!?=])`, 'g')
    : new RegExp(`(?<![\\w])${escapeRe(name)}\\s*\\(`, 'g');
  let n = 0;
  while ((m = callRe.exec(s))) {
    if (defs.has(m.index)) continue;
    if (exclude && m.index >= exclude[0] && m.index < exclude[1]) continue;
    n++;
  }
  return n;
}

function findCallSites({ lang, names, file, proposedSrc, region, repoRoot }) {
  const hits = [];
  const exclude = region ? [region.start, region.endProposed] : null;
  for (const n of names) {
    const c = countCallSites(proposedSrc, lang, n, exclude);
    if (c) hits.push({ name: n, file: file || '(edited file)', count: c });
  }
  if (!repoRoot) return hits;
  // Repo scan, bounded like the JS one: only files naming a function on a
  // word boundary, those that also name the edited module first; at most
  // SCAN_MAX_FILES files / SCAN_MAX_BYTES are scanned (a file that would go
  // over the byte cap is skipped), stripped sources are cached per run, and
  // the scan stops at the first call site (it already fails the check).
  const target = file ? path.resolve(repoRoot, file) : null;
  const nameRe = new RegExp(`(?<![\\w])(?:${names.map(escapeRe).join('|')})(?![\\w])`);
  const stem = target ? path.basename(target).replace(EXTENSIONS[lang], '') : '';
  const modRe = stem && stem !== '__init__' ? new RegExp(`(?<![\\w])${escapeRe(stem)}(?![\\w])`) : null;
  const near = [], far = [];
  for (const f of collectRepoFiles(repoRoot, SCAN_MAX_WALK, EXTENSIONS[lang])) {
    if (f === target) continue;
    const src = safeRead(f);
    if (!src || !nameRe.test(src)) continue;
    (modRe && modRe.test(src) ? near : far).push({ f, src });
  }
  let scanned = 0, bytes = 0;
  for (const { f, src } of near.concat(far)) {
    if (hits.length) { hits.stopped = true; break; }
    if (scanned >= SCAN_MAX_FILES) { hits.capped = true; break; }
    if (bytes + src.length > SCAN_MAX_BYTES) { hits.capped = true; continue; }
    scanned++;
    bytes += src.length;
    const stripped = strippedFor(f, src, lang);
    for (const n of names) {
      const c = countCallSites(src, lang, n, null, stripped);
      if (c) hits.push({ name: n, file: path.relative(repoRoot, f), count: c });
    }
  }
  return hits;
}

const SCAN_MAX_WALK = 2000;
const SCAN_MAX_FILES = 200;
const SCAN_MAX_BYTES = 2_000_000;
const STRIP_CACHE_MAX_BYTES = 64e6;
const stripCache = new Map();
let stripCacheBytes = 0;

// stripCode() per file, cached per process; keyed by path, validated by
// language, size and mtime, bounded in total bytes.
function strippedFor(f, src, lang) {
  let key = null;
  try { const st = fs.statSync(f); key = `${lang}:${st.size}:${st.mtimeMs}:${src.length}`; } catch { /* uncached */ }
  const hit = key && stripCache.get(f);
  if (hit && hit.key === key) return hit.value;
  const value = stripCode(src, lang);
  if (key) {
    if (hit) stripCacheBytes -= hit.value.length;
    stripCache.delete(f);
    stripCache.set(f, { key, value });
    stripCacheBytes += value.length;
    for (const [k, v] of stripCache) {
      if (stripCacheBytes <= STRIP_CACHE_MAX_BYTES) break;
      stripCache.delete(k);
      stripCacheBytes -= v.value.length;
    }
  }
  return value;
}

function checkSignatureDrift(before, after, ctx = {}) {
  const { pairs, removed, added } = pairFunctions(before, after, ctx.region);
  const drift = pairs.filter(([c, p]) => c.params !== p.params).map(([c, p]) => ({ name: c.name, before: c.params, after: p.params }));
  const gone = removed.map(f => ({ name: f.name, removed: true }));
  const all = drift.concat(gone);
  const describe = (d) => d.removed
    ? `${d.name} removed/renamed${added.length ? ` (new: ${added.map(a => a.name).join(', ')})` : ''}`
    : `${d.name}: ${d.before}→${d.after}`;
  if (all.length === 0) {
    return { check_name: 'signature_drift', passed: true, detail: 'no signature changes', severity: 'score' };
  }
  if (!ctx.repoRoot) {
    return { check_name: 'signature_drift', passed: false, severity: 'veto', detail: `${all.map(describe).join('; ')}; call sites not checked (no repo root)` };
  }
  const hits = findCallSites({ lang: before.lang, names: [...new Set(all.map(d => d.name))], file: ctx.file, proposedSrc: ctx.proposedSrc || '', region: ctx.region, repoRoot: ctx.repoRoot });
  const where = hits.map(h => `${h.name} in ${h.file} (${h.count})`).join(', ');
  const scan = hits.stopped ? ' (repo scan stops at the first call site)'
    : hits.capped ? ` (repo scan capped at ${SCAN_MAX_FILES} files / ${SCAN_MAX_BYTES / 1e6} MB mentioning the name; rest not checked)` : '';
  return {
    check_name: 'signature_drift',
    passed: hits.length === 0,
    severity: hits.length ? 'veto' : 'score',
    detail: `${all.map(describe).join('; ')}; ${hits.length ? `call sites outside edit: ${where}` : 'no call sites outside edit'}${scan}`
  };
}

function checkErrorHandlingRemoval(before, after) {
  if (before.tryCount > 0 && after.tryCount < before.tryCount) {
    return { check_name: 'error_handling_removal', passed: false, severity: 'veto', detail: `error-handling blocks: ${before.tryCount} → ${after.tryCount}` };
  }
  return { check_name: 'error_handling_removal', passed: true, severity: 'score', detail: `before=${before.tryCount} after=${after.tryCount}` };
}

function checkNewDependency(before, after, ctx = {}) {
  const beforeSet = new Set(before.imports);
  const added = [...new Set(after.imports)].filter(i => !beforeSet.has(i) && isExternalImport(i, after.lang, ctx.repoRoot));
  if (added.length === 0) {
    return { check_name: 'new_dependency', passed: true, severity: 'score', detail: 'no new external imports' };
  }
  const missing = added.filter(a => !isDeclared(a, after.lang, ctx.repoRoot));
  if (missing.length === 0) {
    return { check_name: 'new_dependency', passed: true, severity: 'score', detail: `added imports are declared: ${added.join(', ')}` };
  }
  return { check_name: 'new_dependency', passed: false, severity: 'veto', detail: `undeclared imports: ${missing.join(', ')}` };
}

function checkReturnTypeChange(before, after, ctx = {}) {
  const { pairs } = pairFunctions(before, after, ctx.region);
  const regressed = [];
  for (const [c, m] of pairs) {
    if (before.lang === 'go') {
      if (c.resultCount > 0 && (m.resultCount !== c.resultCount || (m.returnCount === 0 && !m.panics))) regressed.push(c.name);
      continue;
    }
    if (c.hasReturn && !m.hasReturn) regressed.push(c.name);
  }
  if (regressed.length === 0) {
    return { check_name: 'return_type_change', passed: true, severity: 'score', detail: 'all functions still return' };
  }
  return { check_name: 'return_type_change', passed: false, severity: 'veto', detail: `missing return in: ${regressed.join(', ')}` };
}

// ---------- Python lexical semantics checks ----------
// No Python parser here, so guards and conditions are compared lexically on
// the edited region: a lost `raise`/`assert`/early-exit guard, or a comparison
// operator or literal that disappears from an if/elif/while/assert condition.

function pyRegion(src, region, side) {
  const code = stripCode(src, 'python');
  const lits = stripCode(src, 'python', { keepStrings: true });
  if (!region) return { code, lits };
  const end = side === 'current' ? region.endCurrent : region.endProposed;
  return { code: code.slice(region.start, end), lits: lits.slice(region.start, end) };
}

// -> [{ kw, code, lits, colon }]: each condition's text (strings blanked /
// kept) and the offset just past it.
function pyConditions({ code, lits }) {
  const out = [];
  const re = /^[ \t]*(if|elif|while|assert)\b/gm;
  let m;
  while ((m = re.exec(code))) {
    const from = m.index + m[0].length;
    let depth = 0;
    let j = from;
    for (; j < code.length; j++) {
      const c = code[j];
      if (OPEN[c]) depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      else if (depth <= 0 && c === '\n' && code[j - 1] !== '\\') break;
      else if (depth <= 0 && c === ':' && m[1] !== 'assert') break;
    }
    out.push({ kw: m[1], code: code.slice(from, j), lits: lits.slice(from, j), colon: j });
  }
  return out;
}

const PY_CMP = /\bnot\s+in\b|\bis\s+not\b|==|!=|<=|>=|<|>|\bin\b|\bis\b/g;
const PY_NUM = /(?<![\w.])\d+(?:\.\d+)?(?![\w.])/g;
// Outside conditions (`in` there is also a for-loop keyword): comparison
// operators, the numbers they compare, and default parameter values.
const PY_CMP_ANY = /(?<![<>=!-])(?:==|!=|<=|>=|<|>)(?![<>=])|\bis\s+not\b|\bis\b/g;
const PY_CMP_NUM = /(?:==|!=|<=|>=|<|>)\s*(-?\d+(?:\.\d+)?)(?![\w.])|(?<![\w.])(\d+(?:\.\d+)?)\s*(?:==|!=|<=|>=|<|>)/g;

function literals(code, lits, label) {
  const toks = [];
  for (const n of code.match(PY_NUM) || []) toks.push(`${label} ${n}`);
  const strRe = /(["'])[^"'\n]*\1/g;
  let m;
  while ((m = strRe.exec(code))) toks.push(`${label} ${lits.slice(m.index, m.index + m[0].length)}`);
  return toks;
}

function conditionTokens(r) {
  const toks = [];
  for (const c of pyConditions(r)) {
    for (const op of c.code.match(PY_CMP) || []) toks.push(`condition operator ${op.replace(/\s+/g, ' ')}`);
    toks.push(...literals(c.code, c.lits, 'condition literal'));
  }
  for (const op of r.code.match(PY_CMP_ANY) || []) toks.push(`comparison ${op.replace(/\s+/g, ' ')}`);
  let m;
  const numRe = new RegExp(PY_CMP_NUM.source, 'g');
  while ((m = numRe.exec(r.code))) toks.push(`compared literal ${m[1] || m[2]}`);
  const defRe = /^[ \t]*(?:async[ \t]+)?def[ \t]+\w+[ \t]*\(/gm;
  while ((m = defRe.exec(r.code))) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(r.code, open);
    if (close < 0) continue;
    for (const p of splitTopLevel(r.code.slice(open + 1, close))) {
      const eq = p.indexOf('=');
      if (eq < 0) continue;
      const at = open + 1 + r.code.slice(open + 1, close).indexOf(p);
      toks.push(...literals(r.code.slice(at + eq, at + p.length), r.lits.slice(at + eq, at + p.length), `default ${p.slice(0, eq).trim()}`));
    }
  }
  return toks;
}

// Elements of the `before` multiset missing from `after`.
function lostTokens(before, after) {
  const left = new Map();
  for (const t of after) left.set(t, (left.get(t) || 0) + 1);
  return before.filter((t) => {
    if (!left.get(t)) return true;
    left.set(t, left.get(t) - 1);
    return false;
  });
}

function pyGuards(r) {
  const count = (re) => (r.code.match(re) || []).length;
  const exits = pyConditions(r).filter(c => (c.kw === 'if' || c.kw === 'elif') &&
    /^:[ \t]*(?:\n[ \t]*)*(?:return|raise|continue|break)\b/.test(r.code.slice(c.colon)));
  return {
    raise: count(/(?:^|[:;])[ \t]*raise\b/gm),
    assert: count(/(?:^|[:;])[ \t]*assert\b/gm),
    guard: exits.length
  };
}

// The exception types each `except` clause names (a bare `except:` is `*`).
function pyExcepts(r) {
  const out = [];
  const re = /^[ \t]*except\b([^:\n]*):/gm;
  let m;
  while ((m = re.exec(r.code))) out.push(m[1].replace(/\s+as\s+\w+\s*$/, '').replace(/\s+/g, '') || '*');
  return out;
}

function checkPyGuardRemoval(curR, propR) {
  const b = pyGuards(curR);
  const a = pyGuards(propR);
  const drops = Object.keys(b).filter(k => a[k] < b[k]).map(k => `${k} ${b[k]} → ${a[k]}`);
  const excepts = lostTokens(pyExcepts(curR), pyExcepts(propR));
  if (excepts.length) drops.push(`except ${excepts.join(', ')} changed`);
  if (drops.length) return { check_name: 'guard_removal', passed: false, severity: 'veto', detail: `guards removed: ${drops.join(', ')}` };
  return { check_name: 'guard_removal', passed: true, severity: 'score', detail: `raise=${b.raise} assert=${b.assert} guard=${b.guard} kept` };
}

// `deletes_condition`: fewer comparisons than before, i.e. part of a
// condition is gone, not reworded (stays a veto whatever the diff test says).
function checkPyConditionChange(curR, propR) {
  const b = conditionTokens(curR), a = conditionTokens(propR);
  const gone = lostTokens(b, a);
  const cmps = (t) => t.filter(x => /^(?:comparison|condition operator) /.test(x)).length;
  if (gone.length) {
    const out = { check_name: 'condition_change', passed: false, severity: 'veto', detail: `lost: ${gone.join(', ')}` };
    if (cmps(a) < cmps(b)) out.deletes_condition = true;
    return out;
  }
  return { check_name: 'condition_change', passed: true, severity: 'score', detail: 'comparisons, condition literals and defaults kept' };
}

function pyLexicalChecks(currentSrc, proposedSrc, region) {
  const curR = pyRegion(currentSrc, region, 'current');
  const propR = pyRegion(proposedSrc, region, 'proposed');
  return [checkPyGuardRemoval(curR, propR), checkPyConditionChange(curR, propR)];
}

function runChecks({ file, currentSrc, proposedSrc, repoRoot, region }) {
  const before = parse(file, currentSrc);
  const after = parse(file, proposedSrc);
  if (!before || !after) return null;
  const ctx = { file, repoRoot, region: region || null, proposedSrc };
  return {
    lang: before.lang,
    checks: [
      checkSignatureDrift(before, after, ctx),
      checkErrorHandlingRemoval(before, after),
      checkNewDependency(before, after, ctx),
      checkReturnTypeChange(before, after, ctx),
      ...(before.lang === 'python' ? pyLexicalChecks(currentSrc, proposedSrc, ctx.region) : [])
    ]
  };
}

// ---------- Shared fs helpers ----------

function safeRead(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '__pycache__', '.venv', 'venv', 'vendor', '.tox']);

function collectRepoFiles(root, maxFiles, extRe) {
  const out = [];
  const stack = [root];
  while (stack.length && out.length < maxFiles) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (out.length >= maxFiles) break;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(full);
      } else if (e.isFile() && extRe.test(e.name)) {
        out.push(full);
      }
    }
  }
  return out;
}

module.exports = {
  parse,
  parsePython,
  parseGo,
  parseRuby,
  languageOf,
  runChecks,
  checkSignatureDrift,
  checkErrorHandlingRemoval,
  checkNewDependency,
  checkReturnTypeChange,
  pyLexicalChecks,
  stripCode,
  matchBracket,
  splitTopLevel,
  collectRepoFiles,
  safeRead,
  SCAN_MAX_WALK,
  SCAN_MAX_BYTES,
  PYTHON_STDLIB
};
