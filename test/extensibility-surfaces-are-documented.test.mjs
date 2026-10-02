/**
 * ── ⚠️⚠️ THE HELP TEXT SAID "ALL THREE ARE REAL" AND THERE WERE FOUR ────────
 *
 * MEASURED 2026-08-29, on a package where hooks are 700 lines, wired into
 * `turn.mjs` (`loadHooks` + `createHookRunner`), covered by two test files, and
 * genuinely BLOCKING — a `PreToolUse` hook that exits non-zero refuses the tool
 * call and the model is handed the refusal:
 *
 *     acuvo --help | grep -i hook                              → nothing
 *     grep -i hook lib/cli-args.mjs lib/doctor.mjs lib/slash.mjs → nothing
 *     grep -i hook README.md                                    → 2 hits, both
 *                                                                 about npm
 *                                                                 install scripts
 *
 * ⭐ THAT IS ITEM 14'S DEFECT ON A FOURTH SURFACE. Item 14 was opened because
 * `grep -c -i skill lib/cli-args.mjs` returned 0 while skills worked, and its
 * finding is the one that applies here verbatim: **an extensibility feature
 * nobody can find is extensibility for us and nobody else.** Hooks are the
 * concrete reason a team lets an agent near a real repository — it runs inside
 * THEIR rules rather than ours — and none of it was reachable from anything a
 * stranger reads.
 *
 * ⭐ THE TEST IS STRUCTURAL, for the same reason `presets-are-discoverable` is.
 * It iterates the CONSTANTS each feature owns, so a fifth surface added
 * tomorrow — or a fourth hook event — is covered by a test written before it
 * exists. Asserting the literal string "hooks.json" would pass forever while
 * `SessionStart` shipped dark.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { USAGE } from '../lib/cli-args.mjs';
import { HOOKS_CONFIG_FILE, HOOK_EVENTS } from '../lib/hooks.mjs';
import { SKILLS_DIR } from '../lib/skills.mjs';
import { PLUGINS_DIR, PLUGINS_CONFIG_FILE, PLUGIN_MANIFEST, PLUGIN_CAPABILITIES } from '../lib/plugins.mjs';

/** ⚠️ `USAGE` is exported already joined — `cli-flags-parse` reads it the same way. */
const help = String(USAGE);

/**
 * ⚠️ THE CONFIG FILE PATH IS THE ONE FACT A READER CANNOT GUESS. Every other
 * sentence about hooks is worthless without the place to put them.
 */
test('⚠️⚠️ every extensibility surface names the file a user actually has to create', () => {
  for (const path of [HOOKS_CONFIG_FILE, '.acuvo/commands/', '.acuvo/mcp.json', PLUGINS_DIR, PLUGINS_CONFIG_FILE, PLUGIN_MANIFEST]) {
    assert.ok(help.includes(path), `--help never names ${path}, so the feature is ours and nobody else's`);
  }
  // Skills own their directory name; asserting the literal would drift with it.
  assert.ok(help.includes(SKILLS_DIR), `--help never names ${SKILLS_DIR}`);
});

/**
 * ⭐ THE BLOCKING SENTENCE IS THE ENTRY, NOT A DETAIL OF IT. A hook that can
 * watch but not refuse is a logger, and a logger is not a policy — which is
 * exactly the question somebody deciding whether to let this near their
 * repository is asking.
 */
test('⭐ the hooks entry says the thing that makes hooks worth having: it BLOCKS', () => {
  const line = help.slice(help.indexOf(HOOKS_CONFIG_FILE));
  assert.match(line.slice(0, 600), /BLOCKS/, 'the help never says a PreToolUse hook can refuse a tool call');
});

/**
 * ⚠️ STRUCTURAL OVER LITERAL. `HOOK_EVENTS` is the registry; a fourth event
 * added without a help line would leave a user configuring a name they were
 * never shown, and `parseHooks` refuses an unknown event by name.
 */
test('⚠️ every hook event this CLI accepts is named in --help', () => {
  assert.ok(HOOK_EVENTS.length > 0, 'no events at all — the registry moved');
  for (const event of HOOK_EVENTS) {
    assert.ok(help.includes(event), `--help never names the "${event}" event, which parseHooks requires verbatim`);
  }
});

/**
 * ⚠️ THE COUNT IN THE PROSE IS A SECOND COPY OF A LIST, and the second copy is
 * the one that goes stale — which is precisely how this line came to say
 * "three". It has now been wrong once; this is what stops it being wrong twice.
 */
test('⚠️ the "all N are real" line counts the surfaces that are actually documented below it', () => {
  const header = help.split('\n').find((l) => /Extending it/.test(l));
  assert.ok(header, 'the extensibility header vanished');
  const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
  const claimed = words[String(header.match(/all (\w+) are real/)?.[1] ?? '').toLowerCase()];
  assert.ok(claimed, `the header no longer states a count: ${header}`);

  const documented = [SKILLS_DIR, '.acuvo/commands/', '.acuvo/mcp.json', HOOKS_CONFIG_FILE, PLUGINS_DIR]
    .filter((p) => help.includes(p)).length;
  assert.equal(claimed, documented,
    `--help claims ${claimed} extensibility surfaces and documents ${documented}`);
});

/**
 * ── ⭐⭐ THE PLUGIN ENTRY MUST SAY THE TWO-STEP, AND THIS IS WHY ─────────────
 *
 * Every other surface here works the moment the file exists. A plugin does not:
 * it is INERT until `.acuvo/plugins.json` grants it, deliberately, so that a
 * `git clone` cannot arm arbitrary shell. That is a good rule and a terrible
 * surprise — a user who drops a plugin in, sees nothing happen, and was never
 * told about the second file concludes the feature is broken. The help text is
 * the only place that misunderstanding can be prevented.
 */
test('⭐⭐ the plugins entry names the GRANT file, not only the plugin folder', () => {
  const at = help.indexOf(PLUGINS_DIR);
  assert.ok(at >= 0, `--help never names ${PLUGINS_DIR}`);
  const entry = help.slice(at, at + 900);
  assert.ok(entry.includes(PLUGINS_CONFIG_FILE),
    `the plugins entry never names ${PLUGINS_CONFIG_FILE}, so a user who installs one and sees nothing happen has no way to learn why`);
  assert.match(entry, /GRANT|grant/, 'the entry never says the plugin must be granted');
});

/**
 * ⚠️ STRUCTURAL, like the hook-event test above it. A second capability added
 * to `PLUGIN_CAPABILITIES` without a help line would leave a user writing a
 * manifest naming something they were never shown — and `parsePluginManifest`
 * refuses an unknown capability by name, so the failure is silent-looking.
 */
test('⚠️ every plugin capability this CLI grants is named in --help', () => {
  assert.ok(PLUGIN_CAPABILITIES.length > 0, 'no capabilities at all — the registry moved');
  for (const cap of PLUGIN_CAPABILITIES) {
    assert.ok(help.includes(cap), `--help never names the "${cap}" capability, which a manifest must state verbatim`);
  }
});
