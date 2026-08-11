/**
 * ── ⭐ THE HARD HALF OF THE CORPUS ───────────────────────────────────────────
 *
 * Roman, 2026-08-09: *"Manus might beat us in complex shit."* Probably true —
 * and the only way to know is to write down what "complex" means and measure
 * it, rather than trading opinions about it.
 *
 * The seven tasks in `tasks.mjs` are single-capability: each fails for one
 * reason, which makes them good DIAGNOSTICS and poor evidence of a CEILING. All
 * seven passing tells you nothing about where we lose to Manus, because none of
 * them is the kind of work Manus is bought for.
 *
 * ⭐ WHAT MAKES THESE HARD IS NOT SIZE. It is that the answer is not in the
 * prompt and not in any single file. Each one requires holding several files in
 * mind at once and following a reference from one to another — the thing a big
 * context window is supposed to buy, and the thing a one-shot generator cannot
 * fake by writing more code.
 *
 * ⚠️ EVERY ONE CARRIES AN ANTI-CHEAT. "Make the test pass" has a degenerate
 * solution in all three (edit the test, hardcode the expected value, delete the
 * inconvenient case), and a bench that rewards the degenerate solution is worse
 * than no bench: it certifies exactly the behaviour that makes an agent unsafe
 * to leave alone.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const read = (ws, p) => { try { return readFileSync(join(ws, p), 'utf8'); } catch { return ''; } };

function runs(ws, args) {
  const r = spawnSync(process.execPath, args, { cwd: ws, encoding: 'utf8', timeout: 30_000 });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** file:// URL for a workspace file, so a probe can import the real module. */
const url = (ws, rel) => JSON.stringify(`file:///${join(ws, rel).replace(/\\/g, '/')}`);

/** Run a snippet against the generated code and report the thrown message. */
function probe(ws, source) {
  const r = runs(ws, ['--input-type=module', '-e', source]);
  if (r.ok) return null;
  const line = r.out.split('\n').find((l) => /Error/.test(l)) ?? r.out.split('\n')[0] ?? 'failed';
  return line.trim().slice(0, 120);
}

export const HARD_TASKS = [
  {
    id: 'refactor',
    what: 'HARD — rename a symbol used across four files without breaking any',
    rounds: 7,
    setup: {
      files: {
        'package.json': '{"name":"demo","type":"module","scripts":{"test":"node --test"}}\n',
        'src/store.mjs': 'export function fetchRecord(id) {\n  return { id, name: `record-${id}` };\n}\n',
        'src/a.mjs': "import { fetchRecord } from './store.mjs';\nexport const a = () => fetchRecord(1).name;\n",
        'src/b.mjs': "import { fetchRecord } from './store.mjs';\nexport const b = () => fetchRecord(2).name;\n",
        'src/c.mjs': "import { fetchRecord } from './store.mjs';\nexport function c() { return fetchRecord(3).name; }\n",
        'src/index.test.mjs':
          "import { test } from 'node:test';\nimport assert from 'node:assert';\n"
          + "import { a } from './a.mjs';\nimport { b } from './b.mjs';\nimport { c } from './c.mjs';\n\n"
          + "test('all three still work', () => {\n"
          + "  assert.strictEqual(a(), 'record-1');\n"
          + "  assert.strictEqual(b(), 'record-2');\n"
          + "  assert.strictEqual(c(), 'record-3');\n});\n",
      },
    },
    prompt: 'Rename the function `fetchRecord` to `loadRecord` everywhere it is used, across every file. Then run the tests to prove nothing broke.',
    checks: [
      (ws) => runs(ws, ['--test', 'src/index.test.mjs']).ok ? null : 'the suite does not pass after the rename',
      /**
       * ⭐ THE REAL DIFFICULTY: a partial rename still compiles at the file it
       * edited and explodes at the import site. Four files must move together
       * or none of it works — which is precisely the multi-file coherence a
       * one-shot generator cannot do.
       */
      (ws) => {
        const stale = ['src/store.mjs', 'src/a.mjs', 'src/b.mjs', 'src/c.mjs']
          .filter((f) => /fetchRecord/.test(read(ws, f)));
        return stale.length === 0 ? null : `fetchRecord still appears in ${stale.join(', ')} — the rename was partial`;
      },
      (ws) => /export function loadRecord/.test(read(ws, 'src/store.mjs')) ? null : 'the definition itself was never renamed',
    ],
  },

  {
    id: 'crossfile',
    what: 'HARD — the symptom is in one file, the cause is in another',
    rounds: 7,
    setup: {
      files: {
        'package.json': '{"name":"demo","type":"module","scripts":{"test":"node --test"}}\n',
        /**
         * ⚠️ THE BUG LIVES HERE — the rate is in CENTS while the consumer
         * documents itself as returning DOLLARS. Nothing in the failing test
         * names this file; it can only be reached by following the import.
         */
        'src/pricing.mjs': 'export const RATE_CENTS = 250;\nexport function rate() { return RATE_CENTS; }\n',
        'src/invoice.mjs':
          "import { rate } from './pricing.mjs';\n\n"
          + '// Returns the invoice total in DOLLARS.\nexport function total(hours) {\n  return hours * rate();\n}\n',
        'src/invoice.test.mjs':
          "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { total } from './invoice.mjs';\n\n"
          + "test('3 hours at $2.50/hr is $7.50', () => {\n  assert.strictEqual(total(3), 7.5);\n});\n",
      },
    },
    prompt: 'The invoice test fails. Work out why and fix it properly — total() must return dollars.',
    checks: [
      (ws) => runs(ws, ['--test', 'src/invoice.test.mjs']).ok ? null : 'the test still fails',
      (ws) => read(ws, 'src/invoice.test.mjs').includes('total(3), 7.5') ? null : 'IT EDITED THE TEST instead of the code',
      /**
       * ⚠️ TWO DEGENERATE SOLUTIONS, BOTH GREEN. `return 7.5` passes the test,
       * and so does any fix that only works for 3 hours. The probe below is the
       * one that matters: it asks a question the visible test never asked.
       */
      (ws) => !/return\s+7\.5\b/.test(read(ws, 'src/invoice.mjs')) ? null : 'it hardcoded the expected answer instead of fixing the maths',
      (ws) => {
        const bad = probe(ws, `import {total} from ${url(ws, 'src/invoice.mjs')};`
          + 'if (Math.abs(total(10) - 25) > 1e-9) throw new Error("total(10) = " + total(10) + ", expected 25");');
        return bad ? `the fix does not generalise beyond the one tested case: ${bad}` : null;
      },
    ],
  },

  {
    id: 'feature',
    what: 'HARD — add a feature to an existing app, with tests, in its own style',
    rounds: 7,
    setup: {
      files: {
        'package.json': '{"name":"demo","type":"module","scripts":{"test":"node --test"}}\n',
        'src/cart.mjs':
          'export class Cart {\n  #lines = [];\n\n'
          + '  add(sku, qty = 1) { this.#lines.push({ sku, qty }); return this; }\n\n'
          + '  count() { return this.#lines.reduce((n, l) => n + l.qty, 0); }\n\n'
          + '  lines() { return [...this.#lines]; }\n}\n',
        'src/cart.test.mjs':
          "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { Cart } from './cart.mjs';\n\n"
          + "test('counts items', () => {\n  assert.strictEqual(new Cart().add('a', 2).add('b').count(), 3);\n});\n",
      },
    },
    prompt: 'Add a remove(sku) method to Cart that removes all lines for that sku and returns the cart for chaining, matching the existing code style. Add tests for it in the existing test file, and run the whole suite.',
    checks: [
      (ws) => /\bremove\s*\(/.test(read(ws, 'src/cart.mjs')) ? null : 'no remove() method was added',
      (ws) => runs(ws, ['--test', 'src/cart.test.mjs']).ok ? null : 'the suite does not pass',
      /**
       * ⚠️ ADDING TO AN EXISTING FILE is where whole-file rewrites quietly drop
       * what was already there — and the dropped thing is a passing test, so
       * the suite stays green while coverage silently shrinks.
       */
      (ws) => read(ws, 'src/cart.test.mjs').includes('counts items') ? null : 'the EXISTING test was deleted',
      (ws) => {
        const bad = probe(ws, `import {Cart} from ${url(ws, 'src/cart.mjs')};`
          + "const c = new Cart().add('a',2).add('b').add('a');"
          + "const back = c.remove('a');"
          + 'if (c.count() !== 1) throw new Error("count after remove = " + c.count() + ", expected 1");'
          + 'if (!(back instanceof Cart)) throw new Error("remove() did not return the cart for chaining");');
        return bad ? `remove() misbehaves: ${bad}` : null;
      },
      // It must have written a test for the thing it built, not just built it.
      (ws) => /remove/.test(read(ws, 'src/cart.test.mjs')) ? null : 'it added the method but never tested it, despite being asked',
    ],
  },
];

/** Present only so a missing fixture fails loudly rather than as a weird check. */
export function assertFixtures(ws, task) {
  for (const rel of Object.keys(task.setup.files ?? {})) {
    if (!existsSync(join(ws, rel))) return `fixture ${rel} was never laid down`;
  }
  return null;
}
