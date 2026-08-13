/**
 * ── ⚠️ THE DOCTOR CONTRADICTED ITSELF TWO LINES APART ───────────────────────
 *
 * Real output, one block, 2026-08-13:
 *
 *   live    tools offered here    34 of 47
 *   dark    mcp servers           …the model sees only the 47 tools built into this CLI
 *
 * It computes the honest number — `toolSurface()` returns `{offered, withheld,
 * total}` — and then the MCP line quotes `TOOL_NAMES.length` instead. A reader
 * gets two different answers to "how many tools does the model have" from two
 * adjacent rows of the same report.
 *
 * ⭐ WHY IT MATTERS MORE THAN AN OFF-BY-THIRTEEN: `--doctor` is the command that
 * exists to tell you what is actually working here. A diagnostic that
 * disagrees with itself is worse than one that is simply wrong, because now you
 * cannot use any of it without checking.
 *
 * ⚠️ AND 47 IS THE FLATTERING NUMBER, which is the direction that costs trust.
 * 13 tools are dark on a bare machine: 8 need infrastructure we host, 4 need
 * TypeScript in the user's own project, 1 needs a skills directory.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runDoctor, formatDoctor } from '../lib/doctor.mjs';
import { TOOL_NAMES, toolNamesForRounds } from '../lib/tools.mjs';

const bareDoctor = () => runDoctor({
  env: {},
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: [] }), text: async () => '{}' }),
  skipNetwork: true,
  gitStatusImpl: () => ({ ok: false, error: 'not a repo' }),
  mcpConfigImpl: () => ({ ok: true, file: null, servers: [] }),
});

test('⭐⭐ every tool count the doctor prints agrees with every other one', async () => {
  const report = await bareDoctor();
  const text = formatDoctor(report, { paint: { gold: (s) => s, dim: (s) => s, red: (s) => s, green: (s) => s } });
  const flat = Array.isArray(text) ? text.join('\n') : String(text);

  const offered = toolNamesForRounds(10, { env: {}, allowRun: true, root: process.cwd() }).length;

  /**
   * ⚠️ The specific sentence that was wrong. It must quote what the model
   * actually sees, not the size of the registry — those differ by 13 on a bare
   * machine and the difference is the whole point of the line above it.
   */
  /**
   * ⚠️⚠️ ASSERTED PRESENT FIRST, AND THAT IS NOT PEDANTRY — the first version of
   * this test wrapped the comparison in `if (claim) { … }`. Under mutation the
   * doctor produced no such sentence at all, the guard skipped the assertion,
   * and the test reported GREEN against the exact defect it was written for.
   *
   * A conditional assertion is a check that cannot fail whenever its condition
   * stops holding — which is precisely when something has gone wrong.
   */
  const claim = /sees only the (\d+) tools available in this workspace/.exec(flat);
  assert.ok(
    claim,
    `the MCP line is missing entirely from the report — this test cannot compare counts that are not printed.\n${flat.slice(0, 400)}`,
  );
  assert.equal(
    Number(claim[1]), offered,
    `the MCP line says the model sees ${claim[1]} tools while the surface line says ${offered} — `
    + 'two adjacent rows of one report disagreeing is worse than either being wrong alone',
  );

  // And the honest headline is still present and still says "N of TOTAL".
  assert.match(flat, new RegExp(`${offered} of ${TOOL_NAMES.length}`), 'the surface line keeps both numbers');
});

test('⚠️ the offered count really is smaller on a bare machine — or this test proves nothing', () => {
  /**
   * If a future change made every tool unconditional, `offered === total` and
   * the assertion above would pass for the wrong reason. This is the control.
   */
  const offered = toolNamesForRounds(10, { env: {}, allowRun: true, root: process.cwd() }).length;
  assert.ok(
    offered < TOOL_NAMES.length,
    `expected some tools to be gated on a bare machine, but ${offered} === ${TOOL_NAMES.length}`,
  );
});
