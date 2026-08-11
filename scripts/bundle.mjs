/**
 * ── THE BUNDLER ─────────────────────────────────────────────────────────────
 *
 * One file in, one file out: `bin/acuvo.mjs` and everything it reaches become a
 * single `.mjs` a stranger can curl and run. Zero dependencies, because "zero
 * dependencies" is the package's headline property and a build tool that pulls
 * in half of npm to prove it would be a joke.
 *
 * ⚠️ A BUNDLE THAT IMPORTS CLEANLY AND MISBEHAVES AT RUNTIME IS WORSE THAN NO
 * BUNDLE. It installs in one command and then lies in a way nobody can diff. So
 * this file is built around the four things that silently produce exactly that:
 *
 *   1. `import` / `export` text that is NOT code. `lib/session.mjs` holds a
 *      template literal whose body contains `import { saveSession } from
 *      './session.mjs';` at column 0 — a line-based parser reports a phantom
 *      self-cycle AND rewrites the inside of a string constant that the CLI
 *      prints to users. Hence `maskNonCode`: everything that is a comment, a
 *      string, a template chunk or a regex body becomes spaces, and it preserves
 *      LENGTH and NEWLINES exactly so every offset and line number still points
 *      where it did. Every scan below reads the mask and slices the original.
 *   2. `import.meta.url`. Five sites use it to find the package root or read
 *      package.json. In one flat file there is no package.json one directory up
 *      and `--version` has no try/catch, so the naive bundle dies on the first
 *      command the README tells a stranger to run. Asset references are inlined
 *      and materialised into a temp dir on demand; bare ones are rewritten to a
 *      URL under the bundle's own directory.
 *   3. builtin imports colliding once every module shares one scope — so each
 *      builtin is hoisted ONCE as a namespace (`builtinSlug`) and every module
 *      destructures from it.
 *   4. the shebang: once, at byte 0, nowhere else. A module's own shebang has
 *      its `#!` turned into `//`, which keeps the byte count and kills the
 *      syntax error.
 *
 * ── HOW MODULES ARE JOINED ──────────────────────────────────────────────────
 * Each module becomes `__acuvo_modules['lib/x.mjs'] = (() => { …body…; return
 * { …exports… }; })();` in dependency order. Per-module scope means NOTHING has
 * to be renamed — the hardest and most bug-prone half of a bundler simply does
 * not happen. Imports become destructuring from the registry. A module that
 * contains `await` gets an async wrapper and an awaited call, so top-level await
 * survives. Circular imports are refused by name rather than silently emitting a
 * file where one half of the cycle is undefined.
 *
 * ── WHAT IT WILL NOT DO ─────────────────────────────────────────────────────
 * `export default`, `export *` and re-exports throw with the form named. They
 * are absent from this package, and a bundler that half-supports a form is how
 * you get a bundle that is one byte wrong.
 *
 * ⚠️ IT NEVER OPENS A FILE THAT COULD HOLD A SECRET. It reads exactly the
 * modules in the import graph plus the assets those modules name. No .env, no
 * environment, no glob. That is why the emitted file cannot leak a key, and
 * `scanForSecrets` is the belt to that braces — the output is scanned before it
 * is ever written.
 */

import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join, dirname, resolve, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* ════════════════════════════════════════════════════════════════════════════
 * 1. maskNonCode — the foundation everything else reads.
 * ════════════════════════════════════════════════════════════════════════════ */

const IDENT = /[A-Za-z0-9_$]/;

/**
 * Words after which a `/` opens a regular expression rather than dividing.
 * `return /a"b/.test(x)` is the case that matters here: miss it and the quote
 * inside the pattern is read as a string opener and the rest of the file is
 * garbage.
 */
const KEYWORD_BEFORE_REGEX = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await',
]);

/** Punctuation after which a `/` opens a regex. `)` and `]` are deliberately
 * absent: `(x) / 2` and `arr[0] / 3` are division, and division is far commoner
 * in this codebase than `if (x) /re/.test(y)`. */
const PUNCT_BEFORE_REGEX = '(,=:[!&|?{};+-*%~^<>';

function prevSignificant(out, from) {
  let j = from;
  while (j >= 0 && (out[j] === ' ' || out[j] === '\t' || out[j] === '\r' || out[j] === '\n')) j--;
  return j;
}

function regexAllowed(out, at) {
  const j = prevSignificant(out, at - 1);
  if (j < 0) return true;
  const c = out[j];
  if (IDENT.test(c)) {
    let k = j;
    while (k >= 0 && IDENT.test(out[k])) k--;
    return KEYWORD_BEFORE_REGEX.has(out.slice(k + 1, j + 1).join(''));
  }
  if (c === ')' || c === ']') return false;
  return PUNCT_BEFORE_REGEX.includes(c);
}

/**
 * Blank every byte that is not executable code, preserving length and newlines.
 *
 * ⭐ LENGTH AND NEWLINES ARE THE CONTRACT. Every index the parser finds in the
 * mask is used to slice the ORIGINAL source, so a mask one byte short would
 * rewrite the wrong span — which is precisely how a bundler mangles the inside
 * of a string constant.
 */
export function maskNonCode(src) {
  const n = src.length;
  const out = src.split('');
  const blank = (a, b) => {
    for (let i = a; i < b && i < n; i++) if (out[i] !== '\n') out[i] = ' ';
  };

  let i = 0;

  // A shebang is not JavaScript. Treat it as a comment so nothing downstream
  // trips over the `#`.
  if (src[0] === '#' && src[1] === '!') {
    let e = src.indexOf('\n');
    if (e === -1) e = n;
    blank(0, e);
    i = e;
  }

  let mode = 'code';
  let quote = '';
  let braceDepth = 0;
  const templateBrace = [];

  while (i < n) {
    const c = src[i];

    if (mode === 'code') {
      if (c === '/') {
        const d = src[i + 1];
        if (d === '/') {
          let e = src.indexOf('\n', i);
          if (e === -1) e = n;
          blank(i, e);
          i = e;
          continue;
        }
        if (d === '*') {
          const close = src.indexOf('*/', i + 2);
          const e = close === -1 ? n : close + 2;
          blank(i, e);
          i = e;
          continue;
        }
        if (regexAllowed(out, i)) {
          let j = i + 1;
          let inClass = false;
          let ok = false;
          while (j < n) {
            const r = src[j];
            if (r === '\\') { j += 2; continue; }
            if (r === '\n') break;
            if (inClass) { if (r === ']') inClass = false; j++; continue; }
            if (r === '[') { inClass = true; j++; continue; }
            if (r === '/') { ok = true; break; }
            j++;
          }
          if (ok) {
            blank(i + 1, j); // keep both `/` delimiters, kill the body
            let k = j + 1;
            while (k < n && /[a-z]/i.test(src[k])) k++;
            i = k;
            continue;
          }
        }
        i++;
        continue;
      }
      if (c === "'" || c === '"') { quote = c; mode = 'string'; i++; continue; }
      if (c === '`') { mode = 'template'; i++; continue; }
      if (c === '{') { braceDepth++; i++; continue; }
      if (c === '}') {
        if (templateBrace.length && braceDepth === templateBrace[templateBrace.length - 1]) {
          templateBrace.pop();
          mode = 'template';
          i++;
          continue;
        }
        braceDepth--;
        i++;
        continue;
      }
      i++;
      continue;
    }

    if (mode === 'string') {
      if (c === '\\') { blank(i, i + 2); i += 2; continue; }
      if (c === quote) { mode = 'code'; i++; continue; }
      if (c === '\n') { mode = 'code'; i++; continue; } // unterminated — bail, do not eat the file
      blank(i, i + 1);
      i++;
      continue;
    }

    // template
    if (c === '\\') { blank(i, i + 2); i += 2; continue; }
    if (c === '`') { mode = 'code'; i++; continue; }
    if (c === '$' && src[i + 1] === '{') {
      templateBrace.push(braceDepth);
      mode = 'code';
      i += 2;
      continue;
    }
    blank(i, i + 1);
    i++;
  }

  return out.join('');
}

/* ════════════════════════════════════════════════════════════════════════════
 * 2. parseModule
 * ════════════════════════════════════════════════════════════════════════════ */

const NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function parseNamedList(text) {
  const names = [];
  for (const raw of text.split(',')) {
    const part = raw.trim();
    if (!part) continue;
    const m = part.match(/^([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*))?$/);
    if (!m) throw new Error(`unsupported import/export entry: ${JSON.stringify(part)}`);
    names.push({ imported: m[1], local: m[2] ?? m[1] });
  }
  return names;
}

/** Find `from` as a word, at brace depth 0, starting at `from`. */
function findFromKeyword(masked, start, limit) {
  let depth = 0;
  for (let i = start; i < limit; i++) {
    const c = masked[i];
    if (c === '{') { depth++; continue; }
    if (c === '}') { depth--; continue; }
    if (depth !== 0) continue;
    if (c !== 'f') continue;
    if (masked.slice(i, i + 4) !== 'from') continue;
    const before = i === 0 ? ' ' : masked[i - 1];
    const after = masked[i + 4] ?? ' ';
    if (IDENT.test(before) || IDENT.test(after)) continue;
    return i;
  }
  return -1;
}

function skipSpace(text, i) {
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}

/**
 * Read a module's shape: what it imports, what it exports, the shebang, every
 * `import.meta.url` site, and every dynamic `import()`.
 *
 * Everything is located in the MASK and sliced from the SOURCE, which is the
 * only reason an `import` inside a template literal does not count.
 */
export function parseModule(src) {
  const masked = maskNonCode(src);

  for (const [re, label] of [
    [/(^|[\n;])[ \t]*export\s+default\b/, 'export default'],
    [/(^|[\n;])[ \t]*export\s*\*/, 'export *'],
    [/(^|[\n;])[ \t]*export\s*\{[^}]*\}\s*from\b/, 're-export (`export { … } from …`)'],
  ]) {
    if (re.test(masked)) {
      throw new Error(
        `${label} is not supported by this bundler — no module in this package uses it, ` +
        `and a bundler that half-supports a form is how a bundle ends up one byte wrong.`,
      );
    }
  }

  const shebang = src.startsWith('#!')
    ? src.slice(0, src.indexOf('\n') === -1 ? src.length : src.indexOf('\n'))
    : null;

  /* ── imports ─────────────────────────────────────────────────────────── */
  const imports = [];
  const importRe = /(^|[\n;])([ \t]*)import\b/g;
  let m;
  while ((m = importRe.exec(masked)) !== null) {
    const start = m.index + m[1].length + m[2].length;
    const afterKeyword = start + 'import'.length;
    const next = masked[afterKeyword];
    if (next === '(' || next === '.') continue; // dynamic import / import.meta
    if (next !== undefined && !/[\s{*'"]/.test(next)) continue;

    let p = skipSpace(masked, afterKeyword);
    let names = [];
    let namespace = null;
    let defaultName = null;
    let quoteAt;

    if (masked[p] === "'" || masked[p] === '"') {
      quoteAt = p; // side-effect import: `import './x.mjs';`
    } else {
      const fromAt = findFromKeyword(masked, p, masked.length);
      if (fromAt === -1) continue; // not an import statement we can read
      const clause = masked.slice(p, fromAt);
      const brace = clause.match(/\{([\s\S]*)\}/);
      if (brace) names = parseNamedList(brace[1]);
      const ns = clause.match(/\*\s*as\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
      if (ns) namespace = ns[1];
      const head = clause.split(/[{*]/)[0].trim().replace(/,$/, '').trim();
      if (head && NAME_RE.test(head)) defaultName = head;
      quoteAt = skipSpace(masked, fromAt + 4);
      if (masked[quoteAt] !== "'" && masked[quoteAt] !== '"') continue;
    }

    const close = masked.indexOf(masked[quoteAt], quoteAt + 1);
    if (close === -1) continue;
    const specifier = src.slice(quoteAt + 1, close);

    let end = close + 1;
    while (end < masked.length && (masked[end] === ' ' || masked[end] === '\t')) end++;
    end = masked[end] === ';' ? end + 1 : close + 1;

    imports.push({ names, namespace, defaultName, specifier, start, end });
  }

  /* ── exports ─────────────────────────────────────────────────────────── */
  const exports = [];
  const declRe = /(^|[\n;])([ \t]*)export\s+(async\s+function\s*\*?|function\s*\*?|class|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
  while ((m = declRe.exec(masked)) !== null) {
    const start = m.index + m[1].length + m[2].length;
    const keywordAt = masked.indexOf(m[3].trimEnd()[0], start + 'export'.length);
    exports.push({
      kind: 'decl',
      names: [m[4]],
      locals: [m[4]],
      start,
      end: keywordAt, // [start, end) is `export ` — cut it and the declaration stands alone
    });
  }
  const listRe = /(^|[\n;])([ \t]*)export\s*\{([^}]*)\}\s*;?/g;
  while ((m = listRe.exec(masked)) !== null) {
    const start = m.index + m[1].length + m[2].length;
    const entries = parseNamedList(m[3]);
    exports.push({
      kind: 'list',
      names: entries.map((e) => e.local),
      locals: entries.map((e) => e.imported),
      start,
      end: m.index + m[0].length,
    });
  }
  exports.sort((a, b) => a.start - b.start);

  /* ── import.meta.url ─────────────────────────────────────────────────── */
  const metaUrls = [];
  const newUrlRe = /new\s+URL\s*\(\s*(['"])/g;
  while ((m = newUrlRe.exec(masked)) !== null) {
    const quoteAt = m.index + m[0].length - 1;
    const close = masked.indexOf(m[1], quoteAt + 1);
    if (close === -1) continue;
    const tail = masked.slice(close + 1);
    const t = tail.match(/^\s*,\s*import\.meta\.url\s*\)/);
    if (!t) continue;
    metaUrls.push({
      kind: 'new-url',
      specifier: src.slice(quoteAt + 1, close),
      start: m.index,
      end: close + 1 + t[0].length,
    });
  }
  const bareRe = /import\.meta\.url/g;
  while ((m = bareRe.exec(masked)) !== null) {
    const inside = metaUrls.some((u) => m.index >= u.start && m.index < u.end);
    if (inside) continue;
    metaUrls.push({ kind: 'bare', specifier: null, start: m.index, end: m.index + m[0].length });
  }
  metaUrls.sort((a, b) => a.start - b.start);

  /* ── dynamic import() ────────────────────────────────────────────────── */
  const dynamicImports = [];
  const dynRe = /\bimport\s*\(\s*(['"])/g;
  while ((m = dynRe.exec(masked)) !== null) {
    const quoteAt = m.index + m[0].length - 1;
    const close = masked.indexOf(m[1], quoteAt + 1);
    if (close === -1) continue;
    const t = masked.slice(close + 1).match(/^\s*\)/);
    if (!t) continue;
    dynamicImports.push({
      specifier: src.slice(quoteAt + 1, close),
      start: m.index,
      end: close + 1 + t[0].length,
    });
  }

  return { shebang, imports, exports, metaUrls, dynamicImports, masked };
}

/* ════════════════════════════════════════════════════════════════════════════
 * 3. the graph
 * ════════════════════════════════════════════════════════════════════════════ */

/** `bin/acuvo.mjs` + `../lib/turn.mjs` → `lib/turn.mjs`. Posix ids throughout,
 * so a bundle built on Windows is byte-identical to one built on Linux. */
export function resolveSpecifier(fromId, specifier) {
  return posix.normalize(posix.join(posix.dirname(fromId), specifier));
}

const isRelative = (s) => s.startsWith('./') || s.startsWith('../');
const isBuiltin = (s) => s.startsWith('node:');

/** `node:dns/promises` → `__node_dns_promises`, and never the same as `node:dns`. */
export function builtinSlug(specifier) {
  return `__node_${specifier.replace(/^node:/, '').replace(/[^A-Za-z0-9_$]/g, '_')}`;
}

/**
 * Depth-first, dependencies before dependents.
 *
 * ⚠️ A DYNAMIC IMPORT IS NOT AN ORDERING EDGE. `lib/subagent.mjs` reaches
 * `lib/turn.mjs` through `await import(…)` precisely because the static edge
 * runs the other way; counting it would report a cycle in a tree that has none.
 * The target still has to be IN the bundle, so it is walked as its own root.
 */
export function buildGraph({ entry, readFile }) {
  const modules = new Map();
  const order = [];
  const state = new Map(); // id -> 'open' | 'done'
  const dynamicRoots = [];

  const load = (id, importer) => {
    if (modules.has(id)) return modules.get(id);
    const src = readFile(id);
    if (src === null || src === undefined) {
      throw new Error(
        importer
          ? `cannot resolve '${id}' — imported by '${importer}'`
          : `entry module not found: '${id}'`,
      );
    }
    const parsed = parseModule(src);
    const record = { id, src, parsed };
    modules.set(id, record);
    return record;
  };

  const visit = (id, importer, stack) => {
    const status = state.get(id);
    if (status === 'done') return;
    if (status === 'open') {
      const at = stack.indexOf(id);
      const loop = [...stack.slice(at === -1 ? 0 : at), id].join(' -> ');
      throw new Error(`circular import: ${loop}`);
    }
    const record = load(id, importer);
    state.set(id, 'open');
    stack.push(id);
    for (const imp of record.parsed.imports) {
      if (isBuiltin(imp.specifier)) continue;
      if (!isRelative(imp.specifier)) {
        throw new Error(
          `'${id}' imports '${imp.specifier}' — this package has zero dependencies, ` +
          `so only relative paths and node: builtins can be bundled.`,
        );
      }
      visit(resolveSpecifier(id, imp.specifier), id, stack);
    }
    for (const dyn of record.parsed.dynamicImports) {
      if (isBuiltin(dyn.specifier) || !isRelative(dyn.specifier)) continue;
      dynamicRoots.push([resolveSpecifier(id, dyn.specifier), id]);
    }
    stack.pop();
    state.set(id, 'done');
    order.push(id);
  };

  visit(entry, null, []);
  // Dynamic targets last: they are reachable but never on the init path.
  for (let i = 0; i < dynamicRoots.length; i++) {
    const [id, importer] = dynamicRoots[i];
    if (state.get(id) === 'done') continue;
    visit(id, importer, []);
  }
  // The entry must be evaluated last — it is the one with the side effects.
  if (order.at(-1) !== entry) {
    order.splice(order.indexOf(entry), 1);
    order.push(entry);
  }

  return { order, modules };
}

/* ════════════════════════════════════════════════════════════════════════════
 * 4. bundle
 * ════════════════════════════════════════════════════════════════════════════ */

const REGISTRY = '__acuvo_modules';

function applyEdits(src, edits) {
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  let out = '';
  let at = 0;
  for (const e of sorted) {
    if (e.start < at) continue; // overlapping edit — the outer one already won
    out += src.slice(at, e.start) + e.text;
    at = e.end;
  }
  return out + src.slice(at);
}

const q = (s) => JSON.stringify(s);

function assetPrelude(assets) {
  return [
    'const __acuvo_assets = {',
    ...[...assets.entries()].map(([name, body]) => `  ${q(name)}: ${q(body)},`),
    '};',
    'let __acuvo_assetDir = null;',
    '/**',
    ' * Materialise an inlined asset on first use.',
    ' *',
    ' * ⚠️ INTO A TEMP DIRECTORY, NEVER BESIDE THE BUNDLE. The pitch is "one file";',
    ' * a file that drops a folder next to itself the first time you run it is not',
    ' * one file. The directory is removed on exit.',
    ' */',
    'const __acuvo_asset = (name) => {',
    '  if (__acuvo_assetDir === null) {',
    "    __acuvo_assetDir = __node_fs.mkdtempSync(__node_path.join(__node_os.tmpdir(), 'acuvo-bundle-'));",
    '    try {',
    "      process.on('exit', () => {",
    '        try { __node_fs.rmSync(__acuvo_assetDir, { recursive: true, force: true }); } catch {}',
    '      });',
    '    } catch {}',
    '  }',
    '  const target = __node_path.join(__acuvo_assetDir, name);',
    '  if (!__node_fs.existsSync(target)) {',
    '    __node_fs.mkdirSync(__node_path.dirname(target), { recursive: true });',
    '    __node_fs.writeFileSync(target, __acuvo_assets[name]);',
    '  }',
    '  return __node_url.pathToFileURL(target);',
    '};',
  ].join('\n');
}

const META_PRELUDE = [
  '/**',
  " * A module's own URL, had the tree been unpacked beside this file. `dirname`",
  ' * of it is a real directory, so the package-root arithmetic in the source',
  ' * yields a real path instead of crashing on a file that is not there.',
  ' */',
  "const __acuvo_base = new URL('./', import.meta.url);",
  'const __acuvo_meta = (id) => new URL(id, __acuvo_base).href;',
].join('\n');

/**
 * Turn a module graph into one file.
 *
 * Returns `{ code, assets, moduleIds }`. `assets` is every file inlined because
 * a module named it through `new URL(…, import.meta.url)`.
 */
export function bundle({ entry, readFile }) {
  const { order, modules } = buildGraph({ entry, readFile });

  const builtins = new Set();
  const assets = new Map(); // id -> contents
  const bodies = [];
  const exportedBy = new Map();

  for (const id of order) {
    exportedBy.set(id, new Set(modules.get(id).parsed.exports.flatMap((e) => e.names)));
  }

  for (const id of order) {
    const { src, parsed } = modules.get(id);
    const edits = [];

    if (parsed.shebang) edits.push({ start: 0, end: 2, text: '//' });

    for (const imp of parsed.imports) {
      let source;
      if (isBuiltin(imp.specifier)) {
        builtins.add(imp.specifier);
        source = builtinSlug(imp.specifier);
      } else {
        const target = resolveSpecifier(id, imp.specifier);
        source = `${REGISTRY}[${q(target)}]`;
        const available = exportedBy.get(target);
        for (const n of imp.names) {
          if (available && !available.has(n.imported)) {
            throw new Error(
              `'${id}' imports { ${n.imported} } from '${imp.specifier}', which does not export it`,
            );
          }
        }
      }
      const parts = [];
      if (imp.names.length) {
        const fields = imp.names
          .map((n) => (n.imported === n.local ? n.local : `${n.imported}: ${n.local}`))
          .join(', ');
        parts.push(`const { ${fields} } = ${source};`);
      }
      if (imp.namespace) parts.push(`const ${imp.namespace} = ${source};`);
      if (imp.defaultName) {
        parts.push(
          isBuiltin(imp.specifier)
            ? `const ${imp.defaultName} = ${source}.default ?? ${source};`
            : `const ${imp.defaultName} = ${source}.default;`,
        );
      }
      edits.push({ start: imp.start, end: imp.end, text: parts.join(' ') || ';' });
    }

    for (const exp of parsed.exports) {
      edits.push({ start: exp.start, end: exp.end, text: exp.kind === 'list' ? ';' : '' });
    }

    for (const meta of parsed.metaUrls) {
      if (meta.kind === 'new-url') {
        const assetId = resolveSpecifier(id, meta.specifier);
        if (!assets.has(assetId)) {
          const contents = readFile(assetId);
          if (contents === null || contents === undefined) {
            throw new Error(`'${id}' references the asset '${assetId}', which does not exist`);
          }
          assets.set(assetId, contents);
        }
        edits.push({ start: meta.start, end: meta.end, text: `__acuvo_asset(${q(assetId)})` });
      } else {
        edits.push({ start: meta.start, end: meta.end, text: `__acuvo_meta(${q(id)})` });
      }
    }

    for (const dyn of parsed.dynamicImports) {
      if (!isRelative(dyn.specifier)) continue;
      const target = resolveSpecifier(id, dyn.specifier);
      edits.push({
        start: dyn.start,
        end: dyn.end,
        text: `Promise.resolve(${REGISTRY}[${q(target)}])`,
      });
    }

    const body = applyEdits(src, edits);
    const returns = parsed.exports
      .flatMap((e) => e.names.map((n, i) => [n, e.locals[i] ?? n]))
      .map(([name, local]) => (name === local ? name : `${name}: ${local}`))
      .join(', ');

    // Only an `await` anywhere in the module warrants an async wrapper. Wrapping
    // a module that merely defines async functions would be harmless but adds a
    // microtask tick per module for nothing.
    const wantsAsync = /\bawait\b/.test(parsed.masked);
    const open = wantsAsync ? `await (async () => {` : `(() => {`;

    bodies.push(
      `${REGISTRY}[${q(id)}] = ${open}\n${body}\nreturn { ${returns} };\n})();`,
    );
  }

  const needsAssets = assets.size > 0;
  const needsMeta = order.some((id) => modules.get(id).parsed.metaUrls.some((u) => u.kind === 'bare'));
  if (needsAssets) for (const b of ['node:fs', 'node:path', 'node:os', 'node:url']) builtins.add(b);

  const entryShebang = modules.get(entry).parsed.shebang ?? '#!/usr/bin/env node';

  const head = [
    entryShebang,
    '/* acuvo-code — generated bundle. Do not edit; edit the source tree and run `npm run bundle`. */',
    '',
    // Single-quoted on purpose: `from 'node:fs'` is the form a human greps for.
    ...[...builtins].sort().map((s) => `import * as ${builtinSlug(s)} from '${s}';`),
    '',
    `const ${REGISTRY} = Object.create(null);`,
  ];
  if (needsMeta) head.push('', META_PRELUDE);
  if (needsAssets) head.push('', assetPrelude(assets));

  const code = `${head.join('\n')}\n\n${bodies.join('\n\n')}\n`;

  return { code, assets: [...assets.keys()].sort(), moduleIds: order };
}

/* ════════════════════════════════════════════════════════════════════════════
 * 5. scanForSecrets
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * The shapes that actually leak. Deliberately narrow: a scanner that fires on
 * `process.env.OPENROUTER_API_KEY` teaches everyone to ignore it, and a check
 * that fails correct work is worse than no check.
 *
 * The real guarantee is structural — this bundler only ever opens files named
 * by the import graph — and this is the belt to that braces.
 */
const SECRET_PATTERNS = [
  ['openrouter key', /sk-or-v1-[A-Za-z0-9]{24,}/],
  ['openai key', /sk-[A-Za-z0-9]{32,}/],
  ['github token', /gh[pousr]_[A-Za-z0-9]{30,}/],
  ['aws access key id', /AKIA[0-9A-Z]{16}/],
  ['private key block', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
  ['slack token', /xox[abprs]-[A-Za-z0-9-]{10,}/],
  ['google api key', /AIza[0-9A-Za-z_-]{35}/],
];

export function scanForSecrets(text) {
  const found = [];
  for (const [label, re] of SECRET_PATTERNS) {
    const all = new RegExp(re.source, 'g');
    let m;
    while ((m = all.exec(text)) !== null) {
      found.push({ label, index: m.index, sample: `${m[0].slice(0, 12)}…` });
    }
  }
  return found;
}

/* ════════════════════════════════════════════════════════════════════════════
 * 6. the CLI
 * ════════════════════════════════════════════════════════════════════════════ */

function main(argv) {
  const args = argv.slice(2);
  const flag = (name, fallback) => {
    const i = args.indexOf(name);
    return i === -1 || i === args.length - 1 ? fallback : args[i + 1];
  };
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const entry = flag('--entry', 'bin/acuvo.mjs');
  const out = flag('--out', 'dist/acuvo.mjs');

  const readFile = (id) => {
    try {
      return readFileSync(join(root, id), 'utf8');
    } catch {
      return null;
    }
  };

  const { code, assets, moduleIds } = bundle({ entry, readFile });

  const leaks = scanForSecrets(code);
  if (leaks.length) {
    process.stderr.write(
      `refusing to write ${out} — ${leaks.length} possible secret(s):\n` +
      leaks.map((l) => `  ${l.label} at byte ${l.index} (${l.sample})\n`).join(''),
    );
    return 1;
  }

  const target = resolve(root, out);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, code);
  try { chmodSync(target, 0o755); } catch {}

  process.stdout.write(
    `${out}  ${Buffer.byteLength(code)} bytes  ` +
    `${moduleIds.length} modules  ${assets.length} asset(s): ${assets.join(', ') || 'none'}\n`,
  );
  return 0;
}

const invokedDirectly = process.argv[1]
  && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) process.exit(main(process.argv));
