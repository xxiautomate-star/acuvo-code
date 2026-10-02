/**
 * ── ⭐⭐⭐ DOES THE VERSIONS BLOCK ACTUALLY REACH THE MODEL? ──────────────────
 *
 * `test/docs-context.test.mjs` proves the block is CORRECT. This file proves it
 * is REACHED, and the two are different questions — this repo has shipped the
 * first without the second repeatedly enough that it wrote the rule down:
 *
 *   · `linkinator` had 7 green unit tests, was absent from `package.json`, and
 *     had never crawled anything (INTEGRATIONS.md's own headline).
 *   · `packageDocsChecks()` says "Kept for the doctor" and the doctor has never
 *     called it — zero importers, measured 2026-08-25.
 *   · `[[project_acuvo_corner_assistant_not_mounted]]`: built, exported, trigger
 *     wired, layout says "mounted below", and nothing renders it.
 *
 * ⚠️ AND THE HONEST LIMIT OF THIS FILE IS STATED UP FRONT. The strongest proof
 * would be to run a real turn and read the system message off the wire — that
 * costs a billable agent run, which this lane is forbidden. So reach is proved
 * in two layers, and the weaker one is labelled as such:
 *
 *   LAYER 1 (executable, strong): the REAL `assembleSystemMessage` is called
 *   with a REAL block built from a REAL manifest, and the output is asserted to
 *   contain it, fenced, in the right position. Nothing is faked.
 *
 *   LAYER 2 (source-level, weaker, and honest about it): `turn.mjs`'s call site
 *   is read off disk and asserted to build the block and pass it in. This is the
 *   same technique `every-builtin-skill-is-offered.test.mjs` uses on the skills
 *   shelf, and it is the only layer that can catch a future tidy-up dropping the
 *   argument — which would leave LAYER 1 passing forever against a block nobody
 *   builds.
 *
 * ⚠️ COSTS $0.00 — no network, no model, no key.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { assembleSystemMessage, systemPrompt } from '../lib/turn.mjs';
import { readPinnedVersions, pinnedVersionsBlock } from '../lib/docs-context.mjs';
import { UNTRUSTED_OPEN, UNTRUSTED_CLOSE } from '../lib/untrusted-block.mjs';

const TURN_SOURCE = readFileSync(new URL('../lib/turn.mjs', import.meta.url), 'utf8');

/** A workspace description, in memory — no temp directory, no cleanup to leak. */
function io(files) {
  const norm = (p) => String(p).replace(/\\/g, '/');
  const keys = Object.keys(files).map(norm).sort((a, b) => b.length - a.length);
  const find = (p) => {
    const n = norm(p);
    return keys.find((k) => n === k || n.endsWith(`/${k}`)) ?? null;
  };
  return {
    existsImpl: (p) => find(p) !== null,
    readFileImpl: (p) => {
      const k = find(p);
      if (k === null) throw new Error(`ENOENT ${p}`);
      return files[k];
    },
  };
}

const REAL_MANIFEST = JSON.stringify({
  // The shape read off `console/package.json` on 2026-08-25, trimmed.
  dependencies: { next: '^14.2.35', react: '^18.3.1', '@supabase/supabase-js': '^2.45.4' },
  devDependencies: { typescript: '^5.6.2' },
});

function blockFor(files = { 'package.json': REAL_MANIFEST }) {
  return pinnedVersionsBlock(readPinnedVersions('/repo', io(files)), { canSearch: true });
}

// ── LAYER 1 — through the real assembler ─────────────────────────────────────

test('⭐⭐⭐ the versions block lands in the system message, through the real assembler', () => {
  const versionsBlock = blockFor();
  assert.ok(versionsBlock, 'precondition: the fixture must produce a block');

  const msg = assembleSystemMessage({
    base: systemPrompt({ maxRounds: 8, allowRun: true, offeredNames: ['write_file', 'web_search'] }),
    versionsBlock,
  });

  assert.ok(msg.includes('INSTALLED VERSIONS IN THIS WORKSPACE'), 'the header must reach the message');
  assert.ok(msg.includes('next  ^14.2.35'), 'the actual version must reach the message');
  assert.ok(msg.includes('Write code for THESE versions'), 'the ORDER must reach the message, not just the facts');
});

test('⚠️ it is fenced as untrusted data — a manifest is a file we did not write', () => {
  /**
   * Anyone who can write to a cloned repository writes `package.json`. The
   * fence is the same one `assembleSystemMessage` puts around ACUVO.md and the
   * skills catalogue, and `untrusted-block.mjs` requires EXACTLY ONE of each
   * marker per block so "the payload ends at the closing marker" stays
   * decidable by counting.
   */
  const msg = assembleSystemMessage({ base: 'RULES', versionsBlock: blockFor() });
  const opens = msg.split(UNTRUSTED_OPEN).length - 1;
  const closes = msg.split(UNTRUSTED_CLOSE).length - 1;
  assert.equal(opens, 1);
  assert.equal(closes, 1);
  assert.ok(msg.indexOf(UNTRUSTED_OPEN) < msg.indexOf('INSTALLED VERSIONS'), 'the block is inside the fence');
  assert.ok(msg.indexOf('INSTALLED VERSIONS') < msg.indexOf(UNTRUSTED_CLOSE));
});

test('⭐⭐ our own rules still sit at byte 0 — the cache order survives the new block', () => {
  /**
   * `assembleSystemMessage`'s header: repo-authored material first cost 86
   * points of prefix-cache hit rate (9.7% vs 95.4%), and a hit is up to 50x
   * cheaper than a miss. A new block inserted ahead of `base` would silently
   * reintroduce that, break nothing visible, and cost money forever.
   */
  const base = systemPrompt({ maxRounds: 8, allowRun: true, offeredNames: ['write_file'] });
  const msg = assembleSystemMessage({ base, versionsBlock: blockFor() });
  assert.ok(msg.startsWith(base), 'the constant rules must still be the prefix');
});

test('⭐ the block sits between the notes and the skills catalogue', () => {
  // Stated in `assembleSystemMessage`, and asserted here because ordering is
  // the kind of thing a tidy-up changes without anything going red.
  const msg = assembleSystemMessage({
    base: 'RULES',
    memoryBlock: 'PROJECT NOTES marker-memory',
    versionsBlock: blockFor(),
    skillsBlock: 'SKILLS marker-skills',
    learnedBlock: 'LEARNED marker-learned',
  });
  const at = (s) => msg.indexOf(s);
  assert.ok(at('marker-memory') < at('INSTALLED VERSIONS'));
  assert.ok(at('INSTALLED VERSIONS') < at('marker-skills'));
  assert.ok(at('marker-skills') < at('marker-learned'), 'the volatile block stays last');
});

test('a workspace with no manifest changes the message by exactly nothing', () => {
  /**
   * `acuvo-code` itself is the real case — zero dependencies, by design. An
   * absent capability must cost zero bytes of prefix, not an empty heading.
   */
  const base = systemPrompt({ maxRounds: 8, allowRun: true, offeredNames: ['write_file'] });
  const none = pinnedVersionsBlock(readPinnedVersions('/repo', io({ 'README.md': '# hi' })), { canSearch: true });
  assert.equal(none, null);
  assert.equal(assembleSystemMessage({ base, versionsBlock: none }), base);
});

// ── LAYER 2 — the call site, read off disk ───────────────────────────────────

test('⚠️⚠️ turn.mjs BUILDS the block and PASSES it — the argument cannot be dropped silently', () => {
  /**
   * This is the layer that catches the failure this whole file exists for: a
   * refactor that keeps `assembleSystemMessage` accepting `versionsBlock` while
   * the caller quietly stops computing one. Every assertion in LAYER 1 would
   * still pass, and the capability would be gone.
   */
  assert.match(TURN_SOURCE, /import \{ readPinnedVersions, pinnedVersionsBlock \} from '\.\/docs-context\.mjs';/);
  assert.match(TURN_SOURCE, /versionsBlock = pinnedVersionsBlock\(readPinnedVersions\(executor\.root\)/);
  // and it must actually be handed over, not just computed into a dead local
  assert.match(TURN_SOURCE, /assembleSystemMessage\(\{[\s\S]{0,400}?\n\s*versionsBlock,/);
});

test('⚠️ the tool names in the block are gated on what the turn actually offers', () => {
  /**
   * `tools.mjs` withholds `web_search` and `fetch_url` in single-shot turns on
   * purpose. Naming a verb the model does not have burns the only round
   * discovering it is absent. The gate is asserted at BOTH ends: the caller
   * passes `offered`, and the renderer honours it.
   */
  assert.match(TURN_SOURCE, /canSearch: offered\.includes\('web_search'\)/);
  assert.match(TURN_SOURCE, /canFetch: offered\.includes\('fetch_url'\)/);

  const withNothing = pinnedVersionsBlock(readPinnedVersions('/repo', io({ 'package.json': REAL_MANIFEST })), {});
  assert.doesNotMatch(withNothing, /web_search|fetch_url/);
});

test('⚠️ the manifest is read ONCE per session, not on every continuing round', () => {
  // The memory and learned blocks are both guarded by `continuing` for the same
  // reason: a resumed run already carries the prefix it was built with, and
  // rebuilding it mid-session rewrites a cached prefix to say the same thing.
  assert.match(TURN_SOURCE, /let versionsBlock = null;\s*\n\s*if \(!continuing\) \{/);
});
