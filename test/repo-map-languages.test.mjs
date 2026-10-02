/**
 * ── WHAT THIS SUITE IS GUARDING ─────────────────────────────────────────────
 *
 * ⭐ THE EVIDENCE THAT CAUSED IT, from our own 139 terminal-bench runs in
 * `bench/terminal-bench/results/` (mined 2026-08-29):
 *
 *   · `full-89/fix-ocaml-gc__FvY8K7u` spent **8 of its 10 rounds** answering
 *     "where is `pool_sweep` defined?" — 2 `find_files`, 4 `search_text`,
 *     4 `read_lines` — then died on budget having made no edit. It carried the
 *     SECOND LARGEST repo map in the corpus (~24.2k first-round prompt tokens
 *     against a 13.1k median), and that map could not have shown one symbol,
 *     because the repository is C and OCaml and `SYMBOL_EXT` held nine
 *     extensions, none of them `.c`, `.h`, `.ml` or `.mli`.
 *   · `deep100/build-cython-ext__X7sxaLN` crawled seven rounds of
 *     `list_dir`/`read_file` through ~25KB of source to find one identifier.
 *     Cython — `.pyx`, also absent.
 *
 * ⚠️ AND THE COST OF A MISSING LANGUAGE IS SILENT, NOT MERELY SMALL. A file the
 * extractor refuses renders as a bare path, which is exactly how a file that
 * genuinely defines nothing renders. The model cannot tell "we did not look"
 * from "there is nothing there" — the same confusion `repo-map.mjs`'s own
 * header indicts for invisible FILES, one level down, at the symbol.
 *
 * ── ⚠️ THE RULE EVERY GROUP BELOW OBEYS: NOTHING RATHER THAN GARBAGE ────────
 *
 * Every language here is a REGEX, not a parser, and the whole suite is built to
 * hold that honest. A pattern that is unsure must emit no name, because a name
 * that does not exist sends the model somewhere that does not exist — and a
 * missing name only costs it a `search_text`. So each test asserts the names
 * that MUST appear and, where a naive pattern would produce one, the junk that
 * must NOT: control flow that reads like a call, constants that would crowd out
 * functions, a partial namespace, a private Rust binding.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractExports } from '../lib/repo-map.mjs';
import { INDEX_EXT } from '../lib/repo-index.mjs';

/** Assert the exact set, sorted — a superset is as much a failure as a subset. */
function exact(path, source, expected) {
  assert.deepEqual(
    extractExports(path, source).slice().sort(),
    expected.slice().sort(),
    `${path} did not extract the expected names`,
  );
}

// ── C AND C++ — the language the corpus's worst hunt was written in ─────────

test('⭐ C: definitions and prototypes at column 0, and NOT the calls inside them', () => {
  const src = [
    '#include <stdio.h>',
    '#define MAX 10',
    '#define SQUARE(x) ((x)*(x))',
    'typedef struct pool_s pool_t;',
    'struct heap_state { int n; };',
    'static void pool_sweep(pool_t *p, int gen);',
    'void caml_sweep(struct heap_state *h) {',
    '  if (h->n > 0) { pool_sweep(NULL, 1); }',
    '  for (int i = 0; i < 3; i++) printf("%d", i);',
    '}',
    'int main(int argc, char **argv) { return 0; }',
    '',
  ].join('\n');
  const names = extractExports('runtime/major_gc.c', src);

  // The three the model would actually go looking for.
  for (const want of ['pool_sweep', 'caml_sweep', 'main']) {
    assert.ok(names.includes(want), `C definition ${want} is invisible — this is the bench's worst hunt, unfixed`);
  }
  assert.ok(names.includes('heap_state') && names.includes('pool_s'), 'C aggregate types are invisible');

  /**
   * ⚠️ THE FALSE POSITIVES A NAIVE `\w+\(` WOULD PRODUCE. Control flow reads
   * exactly like a call, and a call inside a body reads exactly like a
   * definition unless the column-0 anchor is doing its job.
   */
  for (const junk of ['if', 'for', 'printf', 'include']) {
    assert.equal(names.includes(junk), false, `emitted ${junk} as a C definition — that is a call or a keyword`);
  }

  /**
   * ⭐ A BARE `#define` IS NOT A SYMBOL, AND THE REASON IS MEASURED. On
   * `cffi/parse_c_type.h`, including constant macros took the file from 4 names
   * to 98 — and because names are sorted and the map shows six, all four real
   * functions were pushed out by `_CFFI_PRIM_*` enum constants. Only
   * FUNCTION-LIKE macros survive, because those are the callable ones.
   */
  assert.ok(names.includes('SQUARE'), 'a function-like macro is callable and belongs in the list');
  assert.equal(names.includes('MAX'), false, 'a constant macro crowds real functions out of a six-name line');
});

test('C headers: prototypes and enums, which is all a header has', () => {
  const src = '#ifndef X_H\n#define X_H\nenum colour { RED, GREEN };\nextern int caml_alloc(size_t n);\n#endif\n';
  exact('include/mem.h', src, ['caml_alloc', 'colour']);
});

test('C++ extensions all reach the same patterns', () => {
  for (const ext of ['cc', 'cpp', 'cxx', 'hpp', 'hh']) {
    const names = extractExports(`src/thing.${ext}`, 'class Widget { };\nint render(int n) { return n; }\n');
    assert.ok(names.includes('Widget') && names.includes('render'), `.${ext} extracted ${JSON.stringify(names)}`);
  }
});

// ── OCAML — the other half of the fix-ocaml-gc repository ───────────────────

test('⭐ OCaml: let / type / module / exception, and the .mli signature too', () => {
  exact('gc.ml', [
    'let rec fact n = if n = 0 then 1 else n * fact (n-1)',
    'type point = { x : int; y : int }',
    'module Heap = struct let empty = [] end',
    'exception Not_here',
    'let sweep h = h',
    '',
  ].join('\n'), ['Heap', 'Not_here', 'fact', 'point', 'sweep']);

  exact('gc.mli', 'val sweep : heap -> unit\ntype heap\nexternal caml_gc : unit -> unit = "caml_gc_stub"\n',
    ['caml_gc', 'heap', 'sweep']);
});

// ── THE JVM-SHAPED FAMILY ───────────────────────────────────────────────────

test('⭐ Java: types at any indent, and methods whose return type contains a SPACE', () => {
  const src = [
    'package a.b;',
    'public class HeapWalker implements Runnable {',
    '  private int count;',
    '  public void sweep(int gen) { if (gen > 0) return; }',
    '  protected static Map<String, Integer> tally(List<String> xs) { return null; }',
    '}',
    'interface Sweeper { }',
    '',
  ].join('\n');
  const names = extractExports('A.java', src);
  assert.ok(names.includes('HeapWalker') && names.includes('Sweeper'));
  assert.ok(names.includes('sweep'));
  /**
   * ⚠️ THIS ONE CAUGHT A REAL BUG IN THE FIRST DRAFT. The return-type character
   * class was `[\w.<>\[\],?]+`, which looks like it covers a generic and does —
   * right up to the space in `Map<String, Integer>`, at which point the match
   * ends and the whole method disappears. Generics get their own group now.
   */
  assert.ok(names.includes('tally'),
    'a method whose return type is a generic with a space vanished — the type pattern cannot span the comma');
  assert.equal(names.includes('count'), false, 'a field is not a method');
  assert.equal(names.includes('if'), false);
});

test('C#: types and methods, but NOT a partial namespace name', () => {
  const src = [
    'namespace App.Core;',
    'public sealed class HeapWalker {',
    '    private readonly int n;',
    '    public async Task<int> SweepAsync(int gen) { return 0; }',
    '}',
    'public record Pair(int A, int B);',
    '',
  ].join('\n');
  const names = extractExports('Heap.cs', src);
  assert.ok(names.includes('HeapWalker') && names.includes('Pair') && names.includes('SweepAsync'));
  /**
   * ⭐ `namespace App.Core` IS DELIBERATELY NOT EXTRACTED. The capture would
   * emit `App` — a name that is declared nowhere — and `find_symbol` would then
   * answer with it. The rule is nothing rather than garbage, and a plausible
   * wrong name is the most expensive kind of garbage.
   */
  assert.equal(names.includes('App'), false, 'emitted a partial namespace as if it were a declared type');
});

test('Kotlin and Swift: functions and types, top level and nested', () => {
  const kt = 'class HeapWalker(val n: Int) {\n    fun sweep(gen: Int): Int = gen\n    private suspend fun tally(): List<Int> = listOf()\n}\nobject Singleton\nfun topLevel(x: Int) = x\n';
  const ktNames = extractExports('Heap.kt', kt);
  for (const w of ['HeapWalker', 'sweep', 'tally', 'Singleton', 'topLevel']) assert.ok(ktNames.includes(w), `kotlin lost ${w}`);

  const sw = 'public struct Heap {\n    public func sweep(gen: Int) -> Int { return gen }\n    private mutating func tally() {}\n}\nprotocol Sweeper {}\nextension Heap: Sweeper {}\nfunc topLevel() {}\n';
  const swNames = extractExports('Heap.swift', sw);
  for (const w of ['Heap', 'sweep', 'tally', 'Sweeper', 'topLevel']) assert.ok(swNames.includes(w), `swift lost ${w}`);
});

// ── THE SCRIPTING FAMILY ────────────────────────────────────────────────────

test('⭐ Ruby: the ? and ! belong to the NAME', () => {
  const src = 'module Gc\n  class Heap\n    def sweep(gen)\n      return if gen.zero?\n    end\n    def self.build; new; end\n    def empty?; true; end\n  end\nend\n';
  const names = extractExports('heap.rb', src);
  for (const w of ['Gc', 'Heap', 'sweep', 'build']) assert.ok(names.includes(w), `ruby lost ${w}`);
  /**
   * ⚠️ `empty?` IS THE IDENTIFIER, NOT `empty`. Validating Ruby names against
   * the bare-identifier rule dropped every predicate and every bang method —
   * which is to say the methods a reader is most likely to be hunting for.
   */
  assert.ok(names.includes('empty?'), 'a predicate method was dropped by the identifier rule');
});

test('PHP: functions, methods and types', () => {
  const src = '<?php\nnamespace App;\nabstract class Heap {\n  public function sweep(int $gen): void {}\n  private static function tally() {}\n}\ninterface Sweeper {}\nfunction top_level_helper($x) { return $x; }\n';
  const names = extractExports('Heap.php', src);
  for (const w of ['Heap', 'Sweeper', 'sweep', 'tally', 'top_level_helper']) assert.ok(names.includes(w), `php lost ${w}`);
});

test('shell: both function forms, and nothing that merely looks like one', () => {
  const src = '#!/bin/bash\nset -e\nsweep_heap() {\n  echo hi\n}\nfunction tally {\n  echo there\n}\nreport() { echo x; }\nif [ -f x ]; then echo y; fi\n';
  exact('scripts/deploy.sh', src, ['report', 'sweep_heap', 'tally']);
  assert.deepEqual(extractExports('x.bash', src).slice().sort(), ['report', 'sweep_heap', 'tally']);
});

test('Lua: plain, local and dotted function definitions', () => {
  exact('mod.lua', 'local M = {}\nfunction M.sweep(gen) return gen end\nlocal function tally() end\nfunction topLevel() end\nreturn M\n',
    ['sweep', 'tally', 'topLevel']);
});

// ── PYTHON'S FAMILY, INCLUDING THE ONE THE BENCH GOT STUCK IN ──────────────

test('⭐ Cython: cdef / cpdef as well as def — the bench’s second-worst hunt', () => {
  const src = 'cdef class Knot:\n    cdef int n\n    def __init__(self, n):\n        self.n = n\n    cpdef int complexity(self):\n        return self.n\ncdef int helper(int a):\n    return a\ndef top_level(x):\n    return x\n';
  const names = extractExports('pyknotid/ccomplexity.pyx', src);
  for (const w of ['Knot', 'complexity', 'helper', 'top_level']) assert.ok(names.includes(w), `cython lost ${w}`);
  assert.ok(extractExports('a.pxd', 'cdef int helper(int a)\n').includes('helper'), '.pxd declarations are invisible');
});

test('Python methods are visible now, not only module-level definitions', () => {
  const names = extractExports('heap.py', 'class Heap:\n    def sweep(self, gen):\n        return gen\n    async def tally(self):\n        pass\ndef top_level():\n    pass\n');
  assert.deepEqual(names.slice().sort(), ['Heap', 'sweep', 'tally', 'top_level']);
});

// ── SQL, WHERE A NAME IS NOT A BARE IDENTIFIER ─────────────────────────────

test('⭐ SQL: the SCHEMA QUALIFIER is part of the name, because two schemas is two tables', () => {
  const src = [
    'create table public.users (id int);',
    'CREATE OR REPLACE FUNCTION audit.log_change() RETURNS trigger AS $$ BEGIN END; $$;',
    'create unique index if not exists users_email_idx on public.users(email);',
    'create materialized view reporting.daily as select 1;',
    '',
  ].join('\n');
  const names = extractExports('migrations/001.sql', src);
  /**
   * ⚠️ `public.users` AND `audit.users` ARE TWO DIFFERENT OBJECTS. Emitting a
   * bare `users` for both says they are one, and validating against the
   * identifier rule would have dropped every qualified name — which in a real
   * migration is most of them.
   */
  assert.ok(names.includes('public.users'), 'the schema qualifier was stripped or the name was rejected outright');
  assert.ok(names.includes('audit.log_change'));
  assert.ok(names.includes('reporting.daily'), 'a multi-word CREATE (materialized view) was not recognised');
  assert.ok(names.includes('users_email_idx'), 'IF NOT EXISTS swallowed the name');
});

// ── SINGLE-FILE COMPONENTS ─────────────────────────────────────────────────

test('.vue and .svelte fall through to the JS patterns and find the script block', () => {
  const src = '<template><div/></template>\n<script>\nexport const NAME = \'x\';\nexport function mounted() {}\n</script>\n';
  for (const ext of ['vue', 'svelte']) {
    const names = extractExports(`Thing.${ext}`, src);
    assert.ok(names.includes('NAME') && names.includes('mounted'), `.${ext} extracted ${JSON.stringify(names)}`);
  }
});

// ── THE TWO PROPERTIES THAT MUST SURVIVE THE WIDENING ──────────────────────

test('⚠️ a language we do not claim still returns NOTHING, not a guess', () => {
  assert.deepEqual(extractExports('a.md', '# export function fake() {}\ndef run(): pass\n'), []);
  assert.deepEqual(extractExports('a.txt', 'void main(void) { }'), []);
  assert.deepEqual(extractExports('a.zig', 'pub fn main() void {}'), []);
  assert.deepEqual(extractExports('a.css', '.export { function: none; }'), []);
});

test('⚠️ every widened extension is bounded — one file cannot produce a thousand-symbol line', () => {
  const c = Array.from({ length: 400 }, (_, i) => `void fn${i}(int a) { }`).join('\n');
  assert.ok(extractExports('big.c', c).length <= 64, 'the C patterns escaped the per-file cap');
  const sql = Array.from({ length: 400 }, (_, i) => `create table s.t${i} (id int);`).join('\n');
  assert.ok(extractExports('big.sql', sql).length <= 64, 'the SQL patterns escaped the per-file cap');
});

/**
 * ⚠️ THE DRIFT GUARD THAT MATTERS MOST. `repo-index.mjs` mirrors `SYMBOL_EXT`
 * as `INDEX_EXT`; if the map decides a `.c` file has symbols and the index does
 * not, `find_symbol` answers "no definition" for a name the map can see. There
 * is already a byte-identity guard in `repo-index.test.mjs`; this one asserts
 * the BEHAVIOUR rather than the source text, so it survives a reformat.
 */
test('⚠️ every extension this suite claims is also indexable — the map and find_symbol must agree', () => {
  const claimed = [
    'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'ml', 'mli', 'java', 'cs', 'rb',
    'php', 'sh', 'bash', 'zsh', 'kt', 'kts', 'swift', 'lua', 'sql', 'pyx', 'pxd',
    'vue', 'svelte', 'py', 'go', 'rs', 'mjs', 'ts', 'tsx',
  ];
  for (const ext of claimed) {
    assert.ok(INDEX_EXT.test(`a.${ext}`), `.${ext} yields symbols but the index will never open it — find_symbol is blind to it`);
  }
});
