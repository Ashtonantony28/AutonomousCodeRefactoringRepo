'use strict';

// Lightweight multi-language structural checks for the four anti-patterns
// when @babel can't parse the file. Each language adapter exposes:
//   parse(src)       -> { functions: [{name, params, returns, hasReturn, alwaysReturns}],
//                         imports: [string],
//                         tryCount: number }
// The orchestrator side joins these by file extension.
//
// This is intentionally regex-driven — heavier parsers (tree-sitter) are
// strictly better but require native compilation. The four checks only
// need coarse counts/identifiers, which regex handles reliably for the
// vast majority of well-formatted source.

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ---------- Python ----------

function parsePython(src) {
  const out = { functions: [], imports: [], tryCount: 0 };
  const lines = src.split('\n');

  const fnRe = /^(\s*)def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(->[^:]+)?:/;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(fnRe);
    if (!m) continue;
    const indent = m[1].length;
    const name = m[2];
    const params = m[3].split(',').map(s => s.trim()).filter(Boolean).length;
    // body = following lines indented more than this def
    let hasReturn = false;
    let allReturnLikelyTrue = true;
    let sawAny = false;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (!l.trim()) continue;
      const li = l.match(/^(\s*)/)[1].length;
      if (li <= indent) break;
      sawAny = true;
      if (/\breturn\b\s+\S/.test(l)) hasReturn = true;
      if (/\braise\b/.test(l)) hasReturn = true;
    }
    // Conservative: only flag "always returns" when there is at least one
    // top-level return at the function's body indent and no obvious if-without-else
    // pattern. We tag hasReturn for the regression check.
    out.functions.push({ name, params, hasReturn, alwaysReturns: hasReturn && sawAny });
  }

  const importRe1 = /^\s*import\s+([A-Za-z_][\w.]*)/gm;
  const importRe2 = /^\s*from\s+([A-Za-z_][\w.]*)\s+import\s+/gm;
  let m;
  while ((m = importRe1.exec(src))) out.imports.push(m[1].split('.')[0]);
  while ((m = importRe2.exec(src))) out.imports.push(m[1].split('.')[0]);

  out.tryCount = (src.match(/\btry\s*:/g) || []).length;
  return out;
}

// ---------- Go ----------

function parseGo(src) {
  const out = { functions: [], imports: [], tryCount: 0 };
  const fnRe = /\bfunc\s+(?:\([^)]*\)\s+)?([A-Za-z_]\w*)\s*\(([^)]*)\)(?:\s*\(([^)]*)\)|\s+([A-Za-z_*\[\]\w.]+))?\s*\{/g;
  let m;
  while ((m = fnRe.exec(src))) {
    const name = m[1];
    const params = m[2].split(',').map(s => s.trim()).filter(Boolean).length;
    const hasReturn = !!(m[3] || m[4]);
    out.functions.push({ name, params, hasReturn, alwaysReturns: hasReturn });
  }
  const impSingle = /^\s*import\s+"([^"]+)"/gm;
  while ((m = impSingle.exec(src))) out.imports.push(m[1]);
  const impBlock = /import\s*\(([\s\S]*?)\)/g;
  while ((m = impBlock.exec(src))) {
    const inner = m[1];
    const lineRe = /"([^"]+)"/g;
    let mm;
    while ((mm = lineRe.exec(inner))) out.imports.push(mm[1]);
  }
  // Go has no try/catch; treat as "has error return" instead — count
  // bare `if err != nil` blocks as the analog.
  out.tryCount = (src.match(/\bif\s+err\s*!=\s*nil\b/g) || []).length;
  return out;
}

// ---------- Ruby ----------

function parseRuby(src) {
  const out = { functions: [], imports: [], tryCount: 0 };
  const fnRe = /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[!?=]?)\s*(?:\(([^)]*)\))?/gm;
  let m;
  while ((m = fnRe.exec(src))) {
    const name = m[1];
    const params = m[2] ? m[2].split(',').map(s => s.trim()).filter(Boolean).length : 0;
    out.functions.push({ name, params, hasReturn: true, alwaysReturns: true });
  }
  const reqRe = /\brequire(?:_relative)?\s+['"]([^'"]+)['"]/g;
  while ((m = reqRe.exec(src))) out.imports.push(m[1]);
  out.tryCount = (src.match(/\bbegin\b[\s\S]*?\brescue\b/g) || []).length
    + (src.match(/\brescue\s+=>/g) || []).length;
  return out;
}

// ---------- Dispatcher ----------

function languageOf(file) {
  if (/\.py$/i.test(file)) return 'python';
  if (/\.go$/i.test(file)) return 'go';
  if (/\.rb$/i.test(file)) return 'ruby';
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

function isExternalImport(name, lang) {
  if (!name) return false;
  if (lang === 'python') {
    // anything not a relative '.foo' is external
    return !name.startsWith('.');
  }
  if (lang === 'go') {
    // external if it contains a '.' (e.g., github.com/foo/bar) and isn't
    // a stdlib path. We only flag non-stdlib here — stdlib paths have no '.'
    return name.includes('.');
  }
  if (lang === 'ruby') {
    return !name.startsWith('.') && !name.startsWith('/');
  }
  return false;
}

function checkSignatureDrift(before, after) {
  const drift = [];
  for (const c of before.functions) {
    const m = after.functions.find(p => p.name === c.name);
    if (m && m.params !== c.params) drift.push({ name: c.name, before: c.params, after: m.params });
  }
  if (drift.length === 0) {
    return { check_name: 'signature_drift', passed: true, detail: 'no signature changes' };
  }
  return {
    check_name: 'signature_drift',
    passed: false,
    detail: drift.map(d => `${d.name}: ${d.before}→${d.after}`).join('; ')
  };
}

function checkErrorHandlingRemoval(before, after) {
  if (before.tryCount > 0 && after.tryCount < before.tryCount) {
    return {
      check_name: 'error_handling_removal',
      passed: false,
      detail: `error-handling blocks: ${before.tryCount} → ${after.tryCount}`
    };
  }
  return { check_name: 'error_handling_removal', passed: true, detail: `before=${before.tryCount} after=${after.tryCount}` };
}

function checkNewDependency(before, after) {
  const beforeSet = new Set(before.imports);
  const added = after.imports.filter(i => !beforeSet.has(i) && isExternalImport(i, after.lang));
  if (added.length === 0) {
    return { check_name: 'new_dependency', passed: true, detail: 'no new external imports' };
  }
  return { check_name: 'new_dependency', passed: false, detail: `added: ${added.join(', ')}` };
}

function checkReturnTypeChange(before, after) {
  const regressed = [];
  for (const c of before.functions) {
    if (!c.hasReturn) continue;
    const m = after.functions.find(p => p.name === c.name);
    if (!m) continue;
    if (c.hasReturn && !m.hasReturn) regressed.push(c.name);
  }
  if (regressed.length === 0) {
    return { check_name: 'return_type_change', passed: true, detail: 'all functions still return' };
  }
  return { check_name: 'return_type_change', passed: false, detail: `missing return in: ${regressed.join(', ')}` };
}

function runChecks({ file, currentSrc, proposedSrc }) {
  const before = parse(file, currentSrc);
  const after = parse(file, proposedSrc);
  if (!before || !after) return null;
  return {
    lang: before.lang,
    checks: [
      checkSignatureDrift(before, after),
      checkErrorHandlingRemoval(before, after),
      checkNewDependency(before, after),
      checkReturnTypeChange(before, after)
    ]
  };
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
  checkReturnTypeChange
};
