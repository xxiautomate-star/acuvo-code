/**
 * ── ⚠️⚠️ SIX LANGUAGES SHIPPED, AND NOTHING TOLD ANYONE ─────────────────────
 *
 * `COMMAND_PRESETS` (lib/command.mjs) has python, go, rust, ruby, make and
 * node-bin — each a vetted argument grammar with its own tests. On 2026-08-13,
 * `grep -c preset lib/cli-args.mjs` returned **0** and `grep -c preset
 * lib/turn.mjs` returned **0**.
 *
 * So the two audiences that decide whether this product works on your repo were
 * both told it does not:
 *   · the DEVELOPER read `--help` saying "What it may execute: node, npm, npx,
 *     tsc … No shell, no pipes, no other program" and concluded the run-and-fix
 *     loop could not touch a Python project;
 *   · the MODEL read a system prompt naming only Node verbs, concluded it could
 *     not verify anything, and either gave up or wrote files it never ran.
 *
 * ⭐ This is the fourth time in two days that a finished, tested capability in
 * this repo turned out to be unreachable — after the multimodal half, the budget
 * governor and `parseAuditLog`. Capability was never the ceiling; being told was.
 *
 * ⭐ SO THIS TEST IS STRUCTURAL, deliberately. Asserting "python is mentioned"
 * would pass forever while a seventh preset shipped dark. It iterates
 * PRESET_NAMES, so the NEXT preset is covered by a test written before it exists.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { USAGE } from '../lib/cli-args.mjs';
import { PRESET_NAMES, COMMAND_PRESETS } from '../lib/command.mjs';

const turnSource = readFileSync(fileURLToPath(new URL('../lib/turn.mjs', import.meta.url)), 'utf8');

test('the detector still finds presets at all — a broken import would make this file assert nothing', () => {
  assert.ok(Array.isArray(PRESET_NAMES) && PRESET_NAMES.length >= 5, `PRESET_NAMES is ${JSON.stringify(PRESET_NAMES)}`);
  for (const name of PRESET_NAMES) {
    assert.ok(COMMAND_PRESETS[name], `${name} is named but has no preset behind it`);
  }
});

test('⭐⭐ every preset appears in --help — the developer must be told the box is bigger', () => {
  for (const name of PRESET_NAMES) {
    assert.ok(
      USAGE.includes(name),
      `--help never mentions the "${name}" preset, so a ${name} developer reads our own help text and `
      + 'concludes this tool cannot run their tests. The capability ships; the sentence does not.',
    );
  }
});

test('⭐⭐ --help names the exact line that enables one', () => {
  /**
   * A capability announced without its switch is a tease. This repo's own rule:
   * a refusal that does not say what to type is just an obstacle — the same
   * applies to an invitation.
   */
  assert.match(USAGE, /\.acuvo\/commands\.json/, 'the per-project file must be named');
  assert.match(USAGE, /ACUVO_ALLOW_COMMANDS/, 'and the per-shell environment variable');
  assert.match(USAGE, /presets/, 'and the JSON key the user has to type');
});

test('⭐⭐ the SYSTEM PROMPT names them too — the model is the other audience, and the one that acts', () => {
  /**
   * ⚠️ The developer reading --help is not the one who decides to run `pytest`.
   * The model does, mid-round, and it only knows what the prompt tells it. This
   * asserts on lib/turn.mjs's source because the prompt builder is not exported;
   * if it ever is, assert on the built string instead — that is strictly better.
   */
  for (const name of PRESET_NAMES) {
    assert.ok(
      turnSource.includes(name),
      `the system prompt never mentions "${name}", so the model will not try it even where it is enabled`,
    );
  }
  assert.match(turnSource, /pytest/, 'and it should name a real command, not just the ecosystem');
});

test('⚠️ the prompt tells the model NOT to enable a preset itself', () => {
  /**
   * `.acuvo/commands.json` is a file the agent can write, and it decides which
   * programs may be spawned. An agent that grants itself an ecosystem has
   * granted itself arbitrary execution — the one decision that must stay with a
   * human. The prompt has to say so out loud, because "it wouldn't think of it"
   * is not a security boundary.
   */
  assert.match(
    turnSource, /Do NOT enable it yourself/,
    'the prompt must forbid self-granting the preset, not merely omit the idea',
  );
});
