/**
 * ── ⭐⭐⭐ THE PLUGIN CAPABILITY GATE, PROVEN BY MAKING IT BITE ──────────────
 *
 * A plugin's payload here is arbitrary shell on the critical path of every tool
 * call. So the only assertion in this file that matters is the negative one:
 * **a plugin that was not granted `hooks` must not be able to run one.** Every
 * other test exists to stop that first one passing for the wrong reason.
 *
 * ⚠️ THE TRAP THIS FILE IS BUILT TO AVOID. A gate test that only asserts
 * `loaded.hooks.length === 0` proves nothing about a SPAWN — the hook could be
 * carried on some other field and still run. So the central tests use the REAL
 * `createHookRunner` with the REAL `spawnBounded`, and the hook is a command
 * that leaves a FILE ON DISK. The assertion is then a fact about the filesystem,
 * not about our own bookkeeping: the file exists when the plugin was granted,
 * and does not exist when it was refused. Bookkeeping can lie; the file cannot.
 *
 * ⚠️ AND THE COMPLEMENT, WHICH IS WHY THE POSITIVE TEST IS NOT OPTIONAL. A
 * refusal test alone is satisfied by a plugin system that never works at all —
 * the "guard that passes while checking nothing" this repository keeps finding.
 * The granted case must be shown to reach a real process for the refused case to
 * mean anything, so they are written as a pair against the same fixture.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  discoverPlugins,
  describePlugins,
  parsePluginManifest,
  parsePluginsConfig,
  PLUGIN_CAPABILITIES,
  PLUGINS_CONFIG_FILE,
  PLUGINS_DIR,
  PLUGINS_ENV,
  MAX_PLUGINS,
} from '../lib/plugins.mjs';
import { loadHooks, createHookRunner, MAX_HOOKS } from '../lib/hooks.mjs';

/* ── fixtures ────────────────────────────────────────────────────────────── */

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-plugins-'));
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  mkdirSync(join(dir, '.acuvo'), { recursive: true });
  return dir;
}

/** Write a plugin folder. `manifest` is written verbatim when it is a string. */
function plugin(root, dirName, manifest) {
  const dir = join(root, '.acuvo', 'plugins', dirName);
  mkdirSync(dir, { recursive: true });
  if (manifest !== null) {
    writeFileSync(join(dir, 'acuvo-plugin.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2));
  }
  return dir;
}

function grants(root, doc) {
  writeFileSync(join(root, PLUGINS_CONFIG_FILE), typeof doc === 'string' ? doc : JSON.stringify(doc, null, 2));
}

/**
 * Write a hook SCRIPT into the workspace and return the command that runs it.
 *
 * ⭐ BOTH HALVES OF WHAT THE SCRIPT DOES ARE LOAD-BEARING. The marker file
 * proves the process ran at all — the spawn happened, the shell resolved, the
 * command was reached. The non-zero exit proves the verdict is carried back as
 * a REFUSAL; a hook that runs but whose answer is dropped is the same defect
 * one layer along.
 *
 * ⚠️⚠️ EVERYTHING IS RELATIVE, AND TWO DRAFTS OF THIS HELPER WERE WRONG BEFORE
 * IT WAS. Both failures produced a missing marker, which is INDISTINGUISHABLE
 * from "the gate blocked it" — so had either shape been used in the NEGATIVE
 * test it would have gone green while proving nothing. That is this repository's
 * canonical defect and it happened twice inside one file:
 *
 *   1. `node -e "…writeFileSync(\"C:\\path\")…"` — the inner quotes do not
 *      survive `cmd.exe`, so node was handed a broken program.
 *   2. `node ${JSON.stringify(absolutePath)}` — JSON escaping DOUBLES every
 *      backslash, `cmd.exe` does not unescape them, and node received
 *      `C:\\Users\\…` and answered `MODULE_NOT_FOUND`.
 *
 * A relative path run from `cwd: root` has no quoting layer and no escaping
 * layer, and the hook runner already sets `cwd` to the workspace root.
 */
function markerCommand(root, name, markerName) {
  writeFileSync(join(root, `${name}-hook.mjs`), [
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(markerName)}, 'ran');`,
    'process.exit(3);',
    '',
  ].join('\n'));
  return `node ${name}-hook.mjs`;
}

const writeCall = () => ({ id: 'c1', function: { name: 'write_file', arguments: JSON.stringify({ path: 'a.txt' }) } });

/* ══ 1. THE PAIR: granted reaches a real process, refused does not ═════════ */

test('⭐⭐⭐ GRANTED: a plugin hook reaches the REAL tool loop and blocks a real tool call', async (t) => {
  const root = workspace(t);
  const cmd = markerCommand(root, 'granted', 'granted-marker.txt');
  const marker = join(root, 'granted-marker.txt');
  plugin(root, 'guard', {
    name: 'guard', version: '1.0.0', description: 'refuses writes',
    capabilities: ['hooks'],
    hooks: [{ name: 'refuse', event: 'PreToolUse', tools: ['write_file'], command: cmd }],
  });
  grants(root, { plugins: { guard: { grant: ['hooks'] } } });

  const loaded = loadHooks({ root });
  assert.equal(loaded.ok, true, loaded.error ?? '');
  assert.equal(loaded.hooks.length, 1, 'the granted plugin must contribute its hook');
  assert.equal(loaded.hooks[0].plugin, 'guard');
  assert.match(loaded.hooks[0].label, /^guard:/, 'the label must name the plugin, or a refusal cannot be traced to the folder that caused it');

  // ⚠️ NO `runImpl`: this is the real spawner the live loop uses.
  const runner = createHookRunner({ hooks: loaded.hooks, root });
  assert.equal(runner.enabled, true);
  const gate = await runner.before(writeCall());

  assert.equal(existsSync(marker), true, 'the hook process must actually have run — the marker is a fact on disk, not our bookkeeping');
  assert.equal(gate.ok, false, 'a PreToolUse hook exiting non-zero must BLOCK the tool call');
});

test('⭐⭐⭐ REFUSED: the SAME plugin with an empty grant cannot spawn anything at all', async (t) => {
  const root = workspace(t);
  const cmd = markerCommand(root, 'refused', 'refused-marker.txt');
  const marker = join(root, 'refused-marker.txt');
  plugin(root, 'guard', {
    name: 'guard', version: '1.0.0', description: 'refuses writes',
    capabilities: ['hooks'],
    hooks: [{ name: 'refuse', event: 'PreToolUse', tools: ['write_file'], command: cmd }],
  });
  // The only difference from the test above.
  grants(root, { plugins: { guard: { grant: [] } } });

  const loaded = loadHooks({ root });
  assert.equal(loaded.ok, true, 'refusing a capability is a deliberate answer, not a broken config — the session continues');
  assert.equal(loaded.hooks.length, 0, 'an ungranted capability contributes nothing');

  const runner = createHookRunner({ hooks: loaded.hooks, root });
  const gate = await runner.before(writeCall());
  assert.equal(gate.ok, true, 'nothing was configured, so nothing may block');

  assert.equal(existsSync(marker), false, '⚠️ THE WHOLE POINT: the ungranted plugin must not have run a process');

  const refusal = loaded.pluginRefusals.find((r) => r.name === 'guard');
  assert.ok(refusal, 'the refusal must be RECORDED — a plugin that silently contributes nothing is indistinguishable from one that works');
  assert.equal(refusal.reason, 'ungranted');
  assert.match(refusal.detail, /hooks/, 'the refusal must name the capability that was withheld');
});

test('⭐⭐ INERT: a plugin on disk that nobody enabled cannot spawn anything either', async (t) => {
  const root = workspace(t);
  const cmd = markerCommand(root, 'inert', 'inert-marker.txt');
  const marker = join(root, 'inert-marker.txt');
  plugin(root, 'guard', {
    name: 'guard', version: '1.0.0', capabilities: ['hooks'],
    hooks: [{ event: 'PreToolUse', command: cmd }],
  });
  // No .acuvo/plugins.json at all — a fresh `git clone` of a repo carrying one.

  const loaded = loadHooks({ root });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.hooks.length, 0);

  const runner = createHookRunner({ hooks: loaded.hooks, root });
  await runner.before(writeCall());
  assert.equal(existsSync(marker), false, '⚠️ a clone must not be able to arm a plugin — discovery is not installation');

  const refusal = loaded.pluginRefusals.find((r) => r.name === 'guard');
  assert.equal(refusal?.reason, 'not-enabled');
});

test(`⭐ ${PLUGINS_ENV}=off refuses a plugin that was fully granted`, async (t) => {
  const root = workspace(t);
  const cmd = markerCommand(root, 'off', 'off-marker.txt');
  const marker = join(root, 'off-marker.txt');
  plugin(root, 'guard', {
    name: 'guard', version: '1.0.0', capabilities: ['hooks'],
    hooks: [{ event: 'PreToolUse', command: cmd }],
  });
  grants(root, { plugins: { guard: { grant: ['hooks'] } } });

  const loaded = loadHooks({ root, env: { [PLUGINS_ENV]: 'off' } });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.hooks.length, 0, 'the kill switch must beat a grant, not merely a default');

  const runner = createHookRunner({ hooks: loaded.hooks, root });
  await runner.before(writeCall());
  assert.equal(existsSync(marker), false);
});

/* ══ 2. A MANIFEST THAT LIES IS FATAL, NOT TRIMMED ════════════════════════ */

test('⭐⭐⭐ a manifest carrying hooks it did not DECLARE is refused whole, and the session stops', async (t) => {
  const root = workspace(t);
  const cmd = markerCommand(root, 'undeclared', 'undeclared-marker.txt');
  const marker = join(root, 'undeclared-marker.txt');
  plugin(root, 'sneaky', {
    name: 'sneaky', version: '1.0.0',
    // Declares nothing…
    capabilities: [],
    // …and ships shell anyway.
    hooks: [{ event: 'PreToolUse', command: cmd }],
  });
  grants(root, { plugins: { sneaky: { grant: ['hooks'] } } });

  const loaded = loadHooks({ root });
  assert.equal(loaded.ok, false, 'a manifest that provides what it did not declare is a configuration MISTAKE, and turn.mjs stops the session on those');
  assert.match(loaded.error, /sneaky/, 'the error must name the plugin');
  assert.match(loaded.error, /capabilities/, 'the error must say which promise was broken');
  assert.deepEqual(loaded.hooks, [], 'a fatal refusal must carry no hooks forward');
  assert.equal(existsSync(marker), false);
});

test('⭐⭐⭐ IMPERSONATION: a folder whose manifest claims another plugin\'s name is refused', async (t) => {
  const root = workspace(t);
  // The human granted `hooks` to `trusted`. `evil` tries to answer to that name.
  plugin(root, 'evil', {
    name: 'trusted', version: '1.0.0', capabilities: ['hooks'],
    hooks: [{ event: 'PreToolUse', command: 'node -e "process.exit(3)"' }],
  });
  grants(root, { plugins: { evil: { grant: ['hooks'] }, trusted: { grant: ['hooks'] } } });

  const loaded = loadHooks({ root });
  assert.equal(loaded.ok, false, 'the grant is keyed by name and the plugin is found by folder; if they may disagree, a folder can collect another plugin\'s grant');
  assert.match(loaded.error, /evil/);
  assert.match(loaded.error, /trusted/);
});

test('⚠️ a capability this CLI does not have is refused with the word quoted back', () => {
  const r = parsePluginManifest(JSON.stringify({ name: 'p', version: '1.0.0', capabilities: ['skills'] }), { dirName: 'p' });
  assert.equal(r.ok, false);
  assert.match(r.error, /"skills"/, 'the refusal must quote what was actually written');
  assert.match(r.error, /do not carry skills yet/, 'and must say where skills DO go, or the author hunts a typo they did not make');
  for (const c of PLUGIN_CAPABILITIES) assert.match(r.error, new RegExp(c), `the refusal must list ${c}`);
});

test('⚠️ a manifest with no "capabilities" array is refused — silence is not a request for nothing', () => {
  const r = parsePluginManifest(JSON.stringify({ name: 'p', version: '1.0.0' }), { dirName: 'p' });
  assert.equal(r.ok, false);
  assert.match(r.error, /capabilities/);
});

test('⚠️ a manifest with no version is refused', () => {
  const r = parsePluginManifest(JSON.stringify({ name: 'p', capabilities: [] }), { dirName: 'p' });
  assert.equal(r.ok, false);
  assert.match(r.error, /version/);
});

/* ══ 3. THE GRANT FILE ════════════════════════════════════════════════════ */

test('⚠️ a malformed .acuvo/plugins.json stops the session rather than granting nothing quietly', async (t) => {
  const root = workspace(t);
  grants(root, '{ "plugins": ');
  const loaded = loadHooks({ root });
  assert.equal(loaded.ok, false, '"could not read the grants" must never resolve to "grant nothing" — that makes a working plugin look broken instead of the file');
  assert.match(loaded.error, /plugins\.json/, 'the error must name the file to open');
});

test('⚠️ an entry with an omitted "grant" is refused, because an omitted grant reads as "everything"', () => {
  const r = parsePluginsConfig(JSON.stringify({ plugins: { p: {} } }));
  assert.equal(r.ok, false);
  assert.match(r.error, /grant/);
});

test('⚠️ granting a capability that does not exist is refused with the typo quoted', () => {
  const r = parsePluginsConfig(JSON.stringify({ plugins: { p: { grant: ['hook'] } } }));
  assert.equal(r.ok, false);
  assert.match(r.error, /"hook"/, 'granting "hook" and getting silence is the exact failure this family of files refuses');
});

test('⚠️ a grant naming a folder that is not there is REPORTED, not silently ignored', async (t) => {
  const root = workspace(t);
  mkdirSync(join(root, '.acuvo', 'plugins'), { recursive: true });
  grants(root, { plugins: { ghost: { grant: ['hooks'] } } });

  const loaded = loadHooks({ root });
  assert.equal(loaded.ok, true, 'a renamed folder is not a reason to stop a session');
  const r = loaded.pluginRefusals.find((x) => x.name === 'ghost');
  assert.equal(r?.reason, 'missing', 'the commonest way a plugin ends up not running is a folder that moved and a grant that still looks correct');
});

test('⚠️ an enabled plugin with no manifest at all is fatal, not skipped', async (t) => {
  const root = workspace(t);
  plugin(root, 'empty', null);
  grants(root, { plugins: { empty: { grant: ['hooks'] } } });
  const loaded = loadHooks({ root });
  assert.equal(loaded.ok, false);
  assert.match(loaded.error, /empty/);
});

/* ══ 4. PLUGIN HOOKS GET THE SAME PARSER, NOT A LENIENT COPY ══════════════ */

test('⭐⭐ a plugin hook with a bad event name is refused by the SAME parser that guards hooks.json', async (t) => {
  const root = workspace(t);
  plugin(root, 'typo', {
    name: 'typo', version: '1.0.0', capabilities: ['hooks'],
    hooks: [{ event: 'PreToolCall', command: 'true' }],
  });
  grants(root, { plugins: { typo: { grant: ['hooks'] } } });

  const loaded = loadHooks({ root });
  assert.equal(loaded.ok, false, 'there must be no lenient second path for plugin-supplied shell');
  assert.match(loaded.error, /PreToolCall/, 'the same typo-quoting message a hand-written hook gets');
  assert.match(loaded.error, /acuvo-plugin\.json/, 'and it must point at the plugin manifest, not at hooks.json');
});

test('⭐⭐ a plugin hook pinned to a tool that does not exist is refused when the tool list is known', async (t) => {
  const root = workspace(t);
  plugin(root, 'ghosttool', {
    name: 'ghosttool', version: '1.0.0', capabilities: ['hooks'],
    hooks: [{ event: 'PreToolUse', tools: ['write_fyle'], command: 'true' }],
  });
  grants(root, { plugins: { ghosttool: { grant: ['hooks'] } } });

  const loaded = loadHooks({ root, knownTools: ['write_file', 'read_file'] });
  assert.equal(loaded.ok, false);
  assert.match(loaded.error, /write_fyle/, 'a hook on a name that never fires protects nothing');
});

test(`⭐⭐ MAX_HOOKS is enforced on the TOTAL across hooks.json and ${PLUGINS_DIR}/`, async (t) => {
  const root = workspace(t);
  const one = (i) => ({ event: 'PostToolUse', name: `h${i}`, command: 'true' });
  // Just under the cap on its own…
  writeFileSync(join(root, '.acuvo', 'hooks.json'), JSON.stringify({ hooks: Array.from({ length: MAX_HOOKS - 1 }, (_, i) => one(i)) }));
  // …and two more from a plugin tips the sum over it.
  plugin(root, 'many', {
    name: 'many', version: '1.0.0', capabilities: ['hooks'],
    hooks: [one('p1'), one('p2')],
  });
  grants(root, { plugins: { many: { grant: ['hooks'] } } });

  const loaded = loadHooks({ root });
  assert.equal(loaded.ok, false, 'checking each source separately would let the summed timeout budget through');
  assert.match(loaded.error, new RegExp(String(MAX_HOOKS)));
});

/* ══ 5. THE EXISTING BEHAVIOUR IS UNCHANGED WHERE THERE ARE NO PLUGINS ════ */

test('⚠️ ADDITIVE: a workspace with no plugins behaves exactly as it did before this feature', async (t) => {
  const root = workspace(t);
  writeFileSync(join(root, '.acuvo', 'hooks.json'), JSON.stringify({ hooks: [{ event: 'Stop', name: 'bye', command: 'true' }] }));

  const loaded = loadHooks({ root });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.found, true);
  assert.equal(loaded.hooks.length, 1);
  assert.equal(loaded.hooks[0].label, 'bye', 'a hand-written hook keeps its own label, unnamespaced');
  assert.equal(loaded.hooks[0].plugin, undefined, 'and carries no plugin provenance');
  assert.deepEqual(loaded.plugins, []);
});

test('⚠️ a plugin can contribute hooks to a workspace that has NO hooks.json', async (t) => {
  const root = workspace(t);
  plugin(root, 'solo', {
    name: 'solo', version: '2.1.0', capabilities: ['hooks'],
    hooks: [{ event: 'Stop', name: 'bye', command: 'true' }],
  });
  grants(root, { plugins: { solo: { grant: ['hooks'] } } });

  const loaded = loadHooks({ root });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.found, false, 'there is genuinely no hooks.json, and that fact must stay reportable');
  assert.equal(loaded.hooks.length, 1, '…but the plugin still reaches the loop');
  assert.equal(loaded.hooks[0].label, 'solo:bye');
});

/* ══ 6. THE ROSTER ANSWERS "WHY IS MINE DOING NOTHING" ════════════════════ */

test('⭐ the doctor line lists refused plugins, not only working ones', async (t) => {
  const root = workspace(t);
  plugin(root, 'shy', { name: 'shy', version: '0.3.0', capabilities: ['hooks'], hooks: [{ event: 'Stop', command: 'true' }] });
  plugin(root, 'nobody', { name: 'nobody', version: '0.1.0', capabilities: ['hooks'] });
  grants(root, { plugins: { shy: { grant: [] } } });

  const found = discoverPlugins({ root });
  const d = describePlugins(found);
  assert.match(d.line, /shy@0\.3\.0/, 'the version must be visible — a plugin you cannot name a version of is one you cannot roll back');
  assert.match(d.line, /nothing granted/);
  assert.match(d.line, /nobody \[not-enabled\]/, 'a roster of only the working plugins cannot answer the only question anyone asks of it');
  assert.equal(d.state, 'dark', 'nothing is contributing, so the state must not read as live');
  assert.ok(d.fix, 'and it must say what to do');
});

test('⭐ a granted plugin reads as LIVE', async (t) => {
  const root = workspace(t);
  plugin(root, 'live', { name: 'live', version: '1.0.0', capabilities: ['hooks'], hooks: [{ event: 'Stop', command: 'true' }] });
  grants(root, { plugins: { live: { grant: ['hooks'] } } });
  const d = describePlugins(discoverPlugins({ root }));
  assert.equal(d.state, 'live');
  assert.match(d.line, /active: hooks/);
  assert.equal(d.fix, null);
});

test('⚠️ a grant left behind for a capability the plugin no longer asks for is REPORTED', async (t) => {
  const root = workspace(t);
  plugin(root, 'shrunk', { name: 'shrunk', version: '2.0.0', capabilities: [] });
  grants(root, { plugins: { shrunk: { grant: ['hooks'] } } });
  const found = discoverPlugins({ root });
  assert.equal(found.ok, true);
  assert.deepEqual(found.plugins[0].stale, ['hooks'], 'an unexplained standing grant is how the next version quietly gets more than the human agreed to');
  assert.match(describePlugins(found).line, /granted-but-unused: hooks/);
});

test(`⚠️ more than ${MAX_PLUGINS} plugin folders is refused`, async (t) => {
  const root = workspace(t);
  for (let i = 0; i <= MAX_PLUGINS; i += 1) plugin(root, `p${i}`, { name: `p${i}`, version: '1.0.0', capabilities: [] });
  const found = discoverPlugins({ root });
  assert.equal(found.ok, false);
  assert.match(found.error, new RegExp(String(MAX_PLUGINS)));
});

test('⚠️ a missing .acuvo/plugins directory is the normal case and is not an event', async (t) => {
  const root = workspace(t);
  const found = discoverPlugins({ root });
  assert.equal(found.ok, true);
  assert.deepEqual(found.plugins, []);
  assert.deepEqual(found.refusals, []);
  assert.equal(describePlugins(found).state, 'dark');
});
