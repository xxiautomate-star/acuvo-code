/**
 * ── ⚠️⚠️⚠️ THE SUITE WAS WRITING TO THE DEVELOPER'S REAL `~/.acuvo` ─────────
 *
 * MEASURED 2026-08-25, on this laptop, while hunting where a bogus provider pin
 * came from. `~/.acuvo/warm-providers.json` is a MACHINE-GLOBAL routing lock:
 * `routeFor` turns whatever it holds into `allow_fallbacks: false` for every
 * workspace on the machine, and the lock only releases on a FAILURE — so a
 * wrong entry is honoured forever, because an expensive success is not a
 * failure. `ECONOMICS.md` prices one such entry (`Novita`) at **4x the cache-read
 * rate we should pay**, and the file also held the single character `"P"`.
 *
 * ⭐ AND THE SUITE IS ONE OF ITS WRITERS. `turn.mjs` ends every session with
 * `saveWarmth(warmth)` — no env, no home — so `warmthPath()` resolves to the
 * real `$HOME/.acuvo`. Twenty-four test files drive `runSession`. Proven by
 * running ONE of them against a cleared file:
 *
 *     node --test test/provider-routing-visibility.test.mjs
 *     ~/.acuvo/warm-providers.json  ->  { "byModel": { "fake/model": "Relace" } }
 *
 * `Relace` is a scripted stub from that file. It never served anything. It was
 * written into the routing lock of the machine Roman actually works on.
 *
 * ⚠️ THIS IS NOT ONLY ABOUT WARMTH. The same directory holds `credentials.json`
 * (a real Acuvo token), `mcp-trust.json` (trust decisions) and
 * `update-check.json`. `model.mjs` already records the other half of this bug in
 * its own words — *"The moment Roman signed in, `~/.acuvo/credentials.json`
 * existed, and a scoped `env: {}` still resolved to the production gateway"* —
 * i.e. the suite's behaviour depends on whether the developer happens to be
 * signed in. A hermetic home fixes both directions at once.
 *
 * ⭐ THE FIX IS IN THE HARNESS, NOT IN EACH TEST. Asking 24 files to remember to
 * pass an env is the arrangement that already failed; `scripts/test.mjs` gives
 * the whole run a throwaway `ACUVO_HOME`, so a module that forgets is contained
 * rather than trusted.
 *
 * ⚠️ THIS FILE RESTORES THE REAL FILE IT INSPECTS. When this guard is RED the
 * end-to-end case below really does write to `$HOME/.acuvo` (that is the bug),
 * so the original bytes are captured first and put back afterwards — a test that
 * proves damage must not also do it.
 *
 * ── ⚠️⚠️ AND THE RESTORE WAS ITSELF A WRITER (found 2026-08-25, by mtime) ────
 *
 * `~/.acuvo/warm-providers.json` kept moving its mtime between sessions while
 * its content stayed `{"byModel":{}}` — the signature of a write that changes
 * nothing. The cause was this file: the `finally` below called
 * `writeFileSync(REAL_WARMTH, before)` UNCONDITIONALLY, so the one guard whose
 * whole subject is "nothing in this suite touches the real home" touched the
 * real home on every single GREEN run, harness or not.
 *
 * ⭐ IT IS NOT COSMETIC, AND "the bytes are identical" IS NOT THE ARGUMENT. A
 * write is a window: it truncates and rewrites a file that a concurrently
 * running real `acuvo` session also writes (`turn.mjs` → `saveWarmth`), and
 * `before` is a snapshot from the top of the test. A restore that fires when
 * there was nothing to restore can therefore REVERT a real session's learned
 * provider — this guard would be re-introducing the class of bug it exists to
 * catch. So the restore now runs only when the bytes actually differ, which is
 * exactly the case it was written for: a RED run.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, unlinkSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { warmthPath } from '../lib/warm-provider.mjs';
import { runSession } from '../lib/turn.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';

const REAL_WARMTH = join(homedir(), '.acuvo', 'warm-providers.json');

const made = [];
after(() => { for (const d of made) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-home-guard-'));
  made.push(root);
  writeFileSync(join(root, 'package.json'), '{"name":"p","version":"1.0.0"}\n');
  writeFileSync(join(root, 'a.js'), 'export const a = 1;\n');
  return root;
}

/**
 * ⭐ THE STATIC HALF. `warmthPath()` with no arguments is exactly what
 * `turn.mjs` reaches, so this is the one line that says whether the run is
 * pointed at a throwaway directory or at the machine's own.
 */
test('⚠️⚠️ the suite runs against a throwaway ACUVO_HOME, never the developer\'s own', () => {
  const home = String(process.env.ACUVO_HOME ?? '').trim();
  assert.ok(home, 'ACUVO_HOME is unset, so every default-path write in this suite lands in $HOME/.acuvo');
  assert.notEqual(
    warmthPath(),
    REAL_WARMTH,
    'the default warmth path resolves to the real home — a stub provider written here becomes a machine-wide, '
    + 'fallback-free routing lock that only a FAILURE can release',
  );
});

/**
 * ⭐⭐ THE END-TO-END HALF, BECAUSE ONLY A REAL RUN PROVES REACH. The static
 * check above can be satisfied by an env var that nothing consults. This drives
 * the actual session loop with a scripted reply and then looks for the stub's
 * name on disk — the same way it was found in production.
 */
test('⭐⭐ a session\'s learned provider lands under ACUVO_HOME, and the real file is untouched', async () => {
  const before = existsSync(REAL_WARMTH) ? readFileSync(REAL_WARMTH, 'utf8') : null;
  /**
   * ⭐ mtime, NOT JUST BYTES. The defect this file shipped with wrote identical
   * content back, so a content comparison was green while a write really did
   * happen. mtime is the only observable that separates "unchanged" from
   * "rewritten with the same bytes", and it is what made the bug visible.
   */
  const mtimeBefore = before === null ? null : statSync(REAL_WARMTH).mtimeMs;
  try {
    const root = workspace();
    const outcome = await runSession({
      task: 'say hello',
      executor: createLocalExecutor(root),
      config: { apiKey: 'x', model: 'guard/model' },
      maxRounds: 2,
      allowRun: false,
      callModelImpl: async () => ({
        ok: true,
        content: 'hello',
        toolCalls: [],
        usage: { cost: 0.0001, total_tokens: 100 },
        finishReason: 'stop',
        model: 'guard/model',
        // ⚠️ A name no upstream has ever had, so finding it on disk is proof of
        // provenance rather than a coincidence with a real provider.
        provider: 'NotARealUpstream',
        providerPin: null,
      }),
      onEvent: () => {},
    });
    assert.equal(outcome.ok, true, 'the session has to complete, or nothing was persisted and this proves nothing');

    const written = existsSync(warmthPath()) ? readFileSync(warmthPath(), 'utf8') : '';
    assert.match(written, /NotARealUpstream/, 'the session did not persist its warmth where ACUVO_HOME says it should');

    const after_ = existsSync(REAL_WARMTH) ? readFileSync(REAL_WARMTH, 'utf8') : null;
    assert.equal(
      after_,
      before,
      'a test session changed the real ~/.acuvo/warm-providers.json — that file is a fallback-free provider lock '
      + 'for every workspace on this machine',
    );

    if (mtimeBefore !== null) {
      assert.equal(
        statSync(REAL_WARMTH).mtimeMs,
        mtimeBefore,
        'the real ~/.acuvo/warm-providers.json was REWRITTEN with identical bytes — a same-content write is still a '
        + 'write, and it can clobber a concurrently running real session\'s learned provider',
      );
    }
  } finally {
    /**
     * ⚠️ Put the machine back exactly as it was, red or green — but ONLY if it
     * moved. `existsSync`/`readFileSync` are reads; the write and the unlink are
     * reached only when the observed state differs from the snapshot, so a green
     * run leaves `~/.acuvo` byte-for-byte AND mtime-for-mtime untouched. That
     * absence of a write is the property the file is named for.
     */
    try {
      const now = existsSync(REAL_WARMTH) ? readFileSync(REAL_WARMTH, 'utf8') : null;
      if (now !== before) {
        if (before === null) unlinkSync(REAL_WARMTH);
        else writeFileSync(REAL_WARMTH, before);
      }
    } catch { /* best effort — never fail a run over housekeeping */ }
  }
});
