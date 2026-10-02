/**
 * ── ⭐⭐⭐ PLUGINS — A NAMED, VERSIONED, CAPABILITY-GATED BUNDLE ──────────────
 *
 * ⚠️ FIRST, THE HONEST FINDING, BECAUSE THE BRIEF FOR THIS FILE ASSUMED A GAP
 * AND HALF OF IT WAS ALREADY CLOSED. This package already had four extension
 * surfaces before a line of this file existed, and they were measured, not
 * remembered — every one of them is a real path on disk today:
 *
 *   `.acuvo/skills/*.md`   procedures the model can open on demand  (skills.mjs)
 *   `.acuvo/commands/*.md` a file `ship.md` becomes `/ship`         (chat.mjs)
 *   `.acuvo/hooks.json`    shell around the tool loop, CAN REFUSE   (hooks.mjs)
 *   `.acuvo/mcp.json`      external tool servers, with a trust store (mcp.mjs)
 *
 * So "we have no extension system" was wrong. What was genuinely absent is the
 * thing that turns four loose config files into a PLUGIN, and it is exactly two
 * properties:
 *
 *   1. **A UNIT.** There is no way to ship one named, versioned thing that a
 *      person installs, names, and can later remove. You ship four files and a
 *      README, and the README is the only record of which of them belong
 *      together.
 *   2. ⭐ **A CAPABILITY DECLARATION AND A REFUSAL.** This is the part neither
 *      Claude Code's plugins nor Codex's have. There, a plugin gets whatever the
 *      CLI can do; `hooks.json` is arbitrary shell on the critical path of every
 *      tool call and it declares NOTHING about itself. Here a plugin must SAY
 *      what it wants, a human must ANSWER, and a mismatch is refused by name.
 *
 * ── ⚠️ THREE RULES, AND EACH ONE IS A REFUSAL SOMEBODY WILL HIT ─────────────
 *
 * **1. DISCOVERY IS NOT INSTALLATION.** A folder under `.acuvo/plugins/` is
 * INERT. It contributes nothing until its name appears in `.acuvo/plugins.json`.
 * `git clone` therefore cannot arm a plugin, which matters because a plugin's
 * whole payload here is arbitrary shell. This is the opposite of the usual
 * plugin-directory convention and it is deliberate: auto-loading whatever is on
 * disk is how a supply-chain problem becomes a supply-chain incident.
 *
 * **2. WHAT IT DECLARES IS A REQUEST; WHAT YOU GRANT IS THE ANSWER.**
 * `capabilities` in the manifest is the plugin asking. `grant` in
 * `.acuvo/plugins.json` is the human replying. Asking for `hooks` and being
 * granted nothing means the hooks DO NOT RUN — and the plugin is listed as
 * refused rather than dropped, because a plugin that silently contributes
 * nothing is indistinguishable from one that is working.
 *
 * **3. ⭐⭐ A MANIFEST THAT LIES IS REFUSED ENTIRELY.** A plugin that carries a
 * `hooks` block without declaring `hooks` in `capabilities` is not a plugin with
 * a small mistake — it is the one shape a capability system exists to stop. It
 * does not get its hooks dropped and the rest kept. The whole plugin is refused,
 * and because that is a CONFIGURATION MISTAKE rather than a human's deliberate
 * "no", it is fatal to the session (see the fatal/quiet split below).
 *
 * ── ⭐ THE FATAL / QUIET SPLIT, WHICH IS THE DESIGN DECISION IN THIS FILE ───
 *
 * `turn.mjs` already aborts a session when `loadHooks` returns `ok:false`, with
 * a comment saying why: *"We cannot know what a hook we could not parse would
 * have refused, so proceeding would be a silent 'yes' on its behalf."* That is
 * the right rule and this file reuses it rather than inventing a second policy —
 * which is also why plugin hooks are merged INSIDE `loadHooks` and this module
 * has no edge into `turn.mjs` at all. Merging at the existing choke point is
 * what makes a plugin's hooks reach the live tool loop with no wiring anywhere
 * else, and this repository's signature defect is capability that is built and
 * never reached.
 *
 * So the two classes are split by WHOSE mistake it is:
 *
 *   FATAL (`ok:false`, the session stops) — the config is WRONG and nobody can
 *     say what was intended: a malformed `.acuvo/plugins.json`, a manifest that
 *     is not valid JSON, a capability name that does not exist, a manifest whose
 *     `name` disagrees with its own folder, a manifest that provides what it did
 *     not declare.
 *   QUIET (recorded, listed, not fatal) — the config is RIGHT and the answer is
 *     no: a plugin nobody enabled, a capability asked for and not granted. These
 *     are somebody's deliberate decision and stopping the session over them
 *     would make the grant file unusable.
 *
 * ⚠️ AND THE ASYMMETRY IS THE POINT: every FATAL case fails CLOSED (nothing from
 * that plugin runs) and every QUIET case also fails closed (nothing from that
 * plugin runs). There is no path in this file where a refusal still contributes.
 *
 * ── ⚠️⚠️ WHY `PLUGIN_CAPABILITIES` HAS EXACTLY ONE MEMBER TODAY ─────────────
 *
 * It would have been one line to also accept `skills` and `commands` in a
 * manifest. It is not here, and the reason is the rule this repository keeps
 * violating: **a capability is added to this list the day its contribution is
 * WIRED, never the day it is imagined.** `hooks` is here because plugin hooks
 * are merged in `loadHooks`, which `turn.mjs` already calls, so a hook from a
 * plugin runs in the real loop — proven by
 * `test/plugins-gate-the-hooks.test.mjs`, not asserted here.
 *
 * `skills` is NOT here because reaching the catalogue means changing
 * `discoverSkills`, whose output is the cacheable prefix of every prompt, and an
 * unproven change there is a cache miss on every session for every user. A
 * manifest asking for `skills` today is REFUSED with that sentence, which is a
 * better answer than accepting the word and doing nothing with it — the
 * accept-and-ignore shape is precisely the "gate that silently lets everything
 * through" that `hooks.mjs` was written to refuse.
 *
 * ── ⚠️ THE IMPERSONATION CHECK, WHICH IS NOT OBVIOUS ────────────────────────
 *
 * The grant in `.acuvo/plugins.json` is keyed by NAME. The plugin is found by
 * FOLDER. If those two are allowed to disagree, then a folder `evil/` carrying a
 * manifest that says `"name": "prettier-guard"` collects whatever the human
 * granted to `prettier-guard`. They must be equal, and a mismatch is fatal.
 *
 * ── ⭐ NO MARKETPLACE, NO REGISTRY, NO INSTALLER, NO NETWORK ────────────────
 *
 * Nothing here fetches anything. A plugin is a folder someone put on their disk
 * by whatever means they already trust — `git clone`, a copy, a submodule. This
 * file's whole job is to decide what that folder is allowed to do, and a
 * download step would put a second, larger trust problem in front of the one
 * being solved.
 *
 * ⭐ PURE AND INJECTABLE. Every function here is a function of its arguments;
 * the filesystem arrives as `readFileImpl` / `readDirImpl`, so the refusals can
 * be proven without a disk.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Where plugin folders live. One folder per plugin. */
export const PLUGINS_DIR = '.acuvo/plugins';

/**
 * The manifest filename inside a plugin folder.
 *
 * ⭐ NAMED, NOT `package.json`. A plugin folder is very often also an npm
 * package (that is how someone will vendor one), and overloading `package.json`
 * would mean this CLI's trust decision is read out of a file that `npm` also
 * rewrites. Claude Code makes the same call with `.claude-plugin/plugin.json`.
 */
export const PLUGIN_MANIFEST = 'acuvo-plugin.json';

/** Where the human answers. Beside `.acuvo/hooks.json` and `.acuvo/commands.json`. */
export const PLUGINS_CONFIG_FILE = '.acuvo/plugins.json';

/** `ACUVO_PLUGINS=off` disables the whole mechanism without editing a file. */
export const PLUGINS_ENV = 'ACUVO_PLUGINS';

/**
 * ⚠️ ONE MEMBER, AND THE HEADER EXPLAINS WHY AT LENGTH. This list grows when a
 * contribution type is WIRED into a loader that the live loop already calls —
 * never when one is merely conceivable.
 */
export const PLUGIN_CAPABILITIES = Object.freeze(['hooks']);

/**
 * ⚠️ A CAP ON THE COUNT, for the same reason `MAX_HOOKS` exists: every plugin
 * hook has its own timeout and they are summed on the critical path of a tool
 * call. Sixteen plugins each contributing a couple of hooks is already past the
 * `MAX_HOOKS` ceiling, which is where the real bound is enforced.
 */
export const MAX_PLUGINS = 16;

/** A manifest is a few hundred bytes. Anything near this is not a manifest. */
export const MAX_MANIFEST_BYTES = 64_000;

/**
 * ⚠️ THE NAME IS A PATH SEGMENT AND A GRANT KEY, so it is constrained rather
 * than sanitised. Sanitising would silently map two different folders onto one
 * grant; refusing does not.
 */
export const PLUGIN_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/;

/* ── the grant file ──────────────────────────────────────────────────────── */

/**
 * Parse `.acuvo/plugins.json` — the human's answer.
 *
 * ```json
 * {
 *   "plugins": {
 *     "prettier-guard": { "grant": ["hooks"] },
 *     "noisy-thing":    { "grant": [] }
 *   }
 * }
 * ```
 *
 * ⚠️ AN ENTRY WITH AN EMPTY `grant` IS NOT THE SAME AS NO ENTRY. No entry means
 * "never heard of it" (the plugin is inert). An empty grant means "I looked at
 * it and said no", which is a different sentence in the doctor and a different
 * thing to see when a plugin you installed does nothing.
 *
 * @param {string} text
 * @param {{ label?: string }} [opts]
 * @returns {{ ok: true, grants: Map<string, string[]> } | { ok: false, error: string }}
 */
export function parsePluginsConfig(text, { label = PLUGINS_CONFIG_FILE } = {}) {
  let doc;
  try {
    doc = JSON.parse(String(text ?? ''));
  } catch (err) {
    return { ok: false, error: `${label} is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, error: `${label} must be a JSON object with a "plugins" object` };
  }
  const raw = doc.plugins;
  if (raw === undefined) return { ok: true, grants: new Map() };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: `${label}: "plugins" must be an object keyed by plugin name` };
  }

  const grants = new Map();
  for (const [name, entry] of Object.entries(raw)) {
    const at = `${label}: plugin "${name}"`;
    if (!PLUGIN_NAME_RE.test(name)) {
      return { ok: false, error: `${at} is not a usable plugin name — lowercase letters, digits, dot, dash and underscore only, and it must match the folder under ${PLUGINS_DIR}/` };
    }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, error: `${at} must be an object like {"grant": ["hooks"]}` };
    }
    const grant = entry.grant;
    if (grant === undefined) {
      return { ok: false, error: `${at} has no "grant" — an entry that grants nothing must say so explicitly with "grant": [], because an omitted grant reads as "everything" to whoever wrote it` };
    }
    if (!Array.isArray(grant) || grant.some((c) => typeof c !== 'string')) {
      return { ok: false, error: `${at}: "grant" must be an array of capability names, e.g. ["hooks"], or [] to grant nothing` };
    }
    for (const c of grant) {
      if (!PLUGIN_CAPABILITIES.includes(c)) {
        /**
         * ⚠️ QUOTED BACK, like the hook-event typo. Granting `"hook"` and
         * getting silence is the failure this whole family of files refuses.
         */
        return { ok: false, error: `${at}: "${c}" is not a capability — this CLI grants ${PLUGIN_CAPABILITIES.join(', ')}` };
      }
    }
    grants.set(name, [...new Set(grant)]);
  }
  return { ok: true, grants };
}

/* ── the manifest ────────────────────────────────────────────────────────── */

/**
 * Parse one `acuvo-plugin.json`.
 *
 * ```json
 * {
 *   "name": "prettier-guard",
 *   "version": "1.0.0",
 *   "description": "Formats what the agent writes and refuses infra/ edits.",
 *   "capabilities": ["hooks"],
 *   "hooks": [
 *     { "event": "PostToolUse", "tools": ["write_file"], "command": "npx prettier --write \"$ACUVO_TOOL_ARG_PATH\"" }
 *   ]
 * }
 * ```
 *
 * ⚠️ THE `hooks` VALUE IS THE SAME SHAPE `.acuvo/hooks.json` ACCEPTS, on
 * purpose. It is handed to `parseHooksConfig` unchanged — so a plugin hook gets
 * the identical event check, tool-name check, timeout ceiling and typo message
 * that a hand-written hook gets, from the one audited parser, rather than a
 * second lenient copy of it living here.
 *
 * @param {string} text
 * @param {{ dirName: string, label?: string }} opts
 * @returns {{ ok: true, manifest: object } | { ok: false, error: string }}
 */
export function parsePluginManifest(text, { dirName, label = PLUGIN_MANIFEST } = {}) {
  const raw = String(text ?? '');
  if (raw.length > MAX_MANIFEST_BYTES) {
    return { ok: false, error: `${label} is ${raw.length} bytes; a manifest is capped at ${MAX_MANIFEST_BYTES}` };
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `${label} is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, error: `${label} must be a JSON object` };
  }

  const name = typeof doc.name === 'string' ? doc.name.trim() : '';
  if (!PLUGIN_NAME_RE.test(name)) {
    return { ok: false, error: `${label}: "name" must be lowercase letters, digits, dot, dash or underscore (got ${JSON.stringify(doc.name ?? null)})` };
  }
  /**
   * ── ⚠️⚠️ THE IMPERSONATION CHECK ────────────────────────────────────────
   * The grant is keyed by name; the plugin is found by folder. If they may
   * disagree, a folder called `evil` claiming `"name": "prettier-guard"`
   * collects prettier-guard's grant. See the header.
   */
  if (name !== dirName) {
    return { ok: false, error: `${label}: "name" is "${name}" but the folder is "${dirName}" — they must match, because ${PLUGINS_CONFIG_FILE} grants by name and a plugin that can rename itself can collect another plugin's grant` };
  }

  const version = typeof doc.version === 'string' ? doc.version.trim() : '';
  if (!version) {
    return { ok: false, error: `${label}: "version" is required — a plugin you cannot name a version of is one you cannot report, pin or roll back` };
  }
  const description = typeof doc.description === 'string' ? doc.description.trim() : '';

  const declared = doc.capabilities;
  if (!Array.isArray(declared) || declared.some((c) => typeof c !== 'string')) {
    return { ok: false, error: `${label}: "capabilities" must be an array of capability names — a plugin that does not say what it wants cannot be granted anything. Use [] for a plugin that contributes nothing.` };
  }
  for (const c of declared) {
    if (!PLUGIN_CAPABILITIES.includes(c)) {
      /**
       * ⚠️ THE `skills` / `commands` MESSAGE IS DELIBERATELY SPECIFIC. Someone
       * writing a manifest will reach for those first; a bare "unknown
       * capability" would send them hunting a typo they did not make.
       */
      const extra = (c === 'skills' || c === 'commands' || c === 'mcp')
        ? ` — acuvo plugins do not carry ${c} yet; put them in .acuvo/${c === 'mcp' ? 'mcp.json' : `${c}/`} directly. A capability is added the day its contribution is wired, not the day it is imagined.`
        : '';
      return { ok: false, error: `${label}: "${c}" is not a capability — this CLI offers ${PLUGIN_CAPABILITIES.join(', ')}${extra}` };
    }
  }
  const capabilities = [...new Set(declared)];

  /**
   * ── ⚠️⚠️ RULE 3: A MANIFEST THAT LIES IS REFUSED ENTIRELY ───────────────
   * Providing a block for a capability that was not declared is the one shape a
   * capability system exists to stop, and it is fatal rather than dropped.
   */
  for (const cap of PLUGIN_CAPABILITIES) {
    if (doc[cap] !== undefined && !capabilities.includes(cap)) {
      return { ok: false, error: `${label}: it carries a "${cap}" block but "${cap}" is not in its own "capabilities" — a manifest that provides what it did not declare is refused whole, not trimmed` };
    }
  }

  return {
    ok: true,
    manifest: {
      name,
      version,
      description,
      capabilities,
      /** Raw, unvalidated. `parseHooksConfig` owns validating it — see the doc above. */
      hooks: doc.hooks === undefined ? null : doc.hooks,
    },
  };
}

/* ── discovery ───────────────────────────────────────────────────────────── */

/**
 * @typedef {{ name: string, reason: string, detail: string, fatal: boolean }} PluginRefusal
 */

/**
 * Read the plugin folders and decide, for each one, what it is allowed to do.
 *
 * Returns EVERY plugin it saw — active and refused alike — because the roster is
 * the thing a human checks when a plugin they installed appears to do nothing,
 * and a list of only the working ones cannot answer that question.
 *
 * ⚠️ NEVER THROWS. A missing `.acuvo/plugins` directory is the normal case for
 * essentially every workspace and is not an event.
 *
 * @param {{
 *   root: string,
 *   env?: Record<string, string|undefined>,
 *   readFileImpl?: (p: string) => string,
 *   readDirImpl?: (p: string) => Array<{name: string, isDirectory: () => boolean}>,
 * }} opts
 * @returns {{ ok: boolean, error?: string, enabled: boolean, plugins: object[], refusals: PluginRefusal[], hookSpecs: object[] }}
 */
export function discoverPlugins({
  root,
  env = process.env,
  readFileImpl = (p) => readFileSync(p, 'utf8'),
  readDirImpl = (p) => readdirSync(p, { withFileTypes: true }),
} = {}) {
  const none = { ok: true, enabled: true, plugins: [], refusals: [], hookSpecs: [] };

  if (String(env?.[PLUGINS_ENV] ?? '').trim().toLowerCase() === 'off') {
    return { ...none, enabled: false };
  }

  const base = String(root ?? '');

  /**
   * ⭐ THE GRANT FILE IS READ FIRST AND ON ITS OWN. If it is broken we stop
   * before looking at a single plugin: we cannot know what was granted, and
   * "could not read the grants" must never resolve to "grant nothing quietly",
   * which would make a working plugin look broken instead of the file.
   */
  let grants = new Map();
  let grantText = null;
  try {
    grantText = readFileImpl(join(base, PLUGINS_CONFIG_FILE));
  } catch (err) {
    const code = err && typeof err === 'object' ? /** @type {{code?: unknown}} */ (err).code : undefined;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      return { ...none, ok: false, error: `${PLUGINS_CONFIG_FILE} could not be read: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  if (grantText !== null) {
    const parsed = parsePluginsConfig(grantText);
    if (!parsed.ok) return { ...none, ok: false, error: parsed.error };
    grants = parsed.grants;
  }

  let entries;
  try {
    entries = readDirImpl(join(base, PLUGINS_DIR));
  } catch {
    // No plugins directory: the normal case. If a grant file named plugins that
    // are not on disk, that is reported below rather than silently ignored.
    entries = [];
  }

  const dirs = (Array.isArray(entries) ? entries : [])
    .filter((d) => d && typeof d.name === 'string' && typeof d.isDirectory === 'function' && d.isDirectory())
    .map((d) => d.name)
    // Stable across machines for the same reason the skills catalogue is.
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  if (dirs.length > MAX_PLUGINS) {
    return { ...none, ok: false, error: `${PLUGINS_DIR} holds ${dirs.length} folders; the limit is ${MAX_PLUGINS}` };
  }

  /** @type {object[]} */ const plugins = [];
  /** @type {PluginRefusal[]} */ const refusals = [];
  /** @type {object[]} */ const hookSpecs = [];
  const seenDirs = new Set(dirs);

  for (const dirName of dirs) {
    const label = `${PLUGINS_DIR}/${dirName}/${PLUGIN_MANIFEST}`;

    /**
     * ⭐ RULE 1, AND IT IS CHECKED BEFORE THE MANIFEST IS EVEN READ. A folder
     * nobody enabled is inert, so a malformed manifest in a plugin you never
     * enabled cannot stop your session. Reading it first would let anyone who
     * can write into your repo halt your agent with a stray brace.
     */
    if (!grants.has(dirName)) {
      refusals.push({
        name: dirName,
        reason: 'not-enabled',
        detail: `found in ${PLUGINS_DIR}/ but not listed in ${PLUGINS_CONFIG_FILE} — a plugin on disk is inert until you name it, so a clone cannot arm one`,
        fatal: false,
      });
      continue;
    }

    if (!PLUGIN_NAME_RE.test(dirName)) {
      refusals.push({ name: dirName, reason: 'bad-name', detail: `"${dirName}" is not a usable plugin folder name`, fatal: true });
      continue;
    }

    let text;
    try {
      text = readFileImpl(join(base, PLUGINS_DIR, dirName, PLUGIN_MANIFEST));
    } catch (err) {
      const code = err && typeof err === 'object' ? /** @type {{code?: unknown}} */ (err).code : undefined;
      refusals.push({
        name: dirName,
        reason: 'no-manifest',
        detail: (code === 'ENOENT' || code === 'ENOTDIR')
          ? `${label} does not exist — you enabled "${dirName}" in ${PLUGINS_CONFIG_FILE} but the folder carries no manifest`
          : `${label} could not be read: ${err instanceof Error ? err.message : String(err)}`,
        fatal: true,
      });
      continue;
    }

    const parsed = parsePluginManifest(text, { dirName, label });
    if (!parsed.ok) {
      refusals.push({ name: dirName, reason: 'invalid', detail: parsed.error, fatal: true });
      continue;
    }
    const manifest = parsed.manifest;
    const granted = grants.get(dirName) ?? [];

    /**
     * ── ⭐⭐ RULE 2, THE ONE THE WHOLE FILE IS FOR ───────────────────────────
     * Declared minus granted. Every capability in that difference is refused BY
     * NAME, and the plugin still appears in the roster carrying the refusal, so
     * "why is my formatter not running" has an answer on one line.
     */
    const ungranted = manifest.capabilities.filter((c) => !granted.includes(c));
    const active = manifest.capabilities.filter((c) => granted.includes(c));

    if (ungranted.length) {
      refusals.push({
        name: dirName,
        reason: 'ungranted',
        detail: `asks for ${ungranted.join(', ')} and ${granted.length ? `was granted only ${granted.join(', ')}` : 'was granted nothing'} — those contributions do not run`,
        fatal: false,
      });
    }

    /**
     * ⚠️ GRANTING A CAPABILITY THE PLUGIN NEVER ASKED FOR IS ALSO REPORTED. It
     * is harmless today, but it is nearly always a grant left behind after the
     * plugin was updated, and an unexplained standing grant is how the next
     * version quietly gets more than the human last agreed to.
     */
    const stale = granted.filter((c) => !manifest.capabilities.includes(c));

    plugins.push({
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      dir: `${PLUGINS_DIR}/${dirName}`,
      declared: manifest.capabilities,
      granted,
      active,
      ungranted,
      stale,
    });

    if (active.includes('hooks') && manifest.hooks != null) {
      hookSpecs.push({ name: manifest.name, dir: `${PLUGINS_DIR}/${dirName}`, hooks: manifest.hooks });
    }
  }

  /**
   * ⚠️ A GRANT FOR A PLUGIN THAT IS NOT THERE IS A FACT, NOT A NO-OP. It is the
   * commonest way a plugin ends up not running: the folder was renamed, moved or
   * never checked out, and the grant file still looks correct.
   */
  for (const name of grants.keys()) {
    if (!seenDirs.has(name)) {
      refusals.push({
        name,
        reason: 'missing',
        detail: `${PLUGINS_CONFIG_FILE} enables "${name}" but ${PLUGINS_DIR}/${name}/ does not exist`,
        fatal: false,
      });
    }
  }

  const fatal = refusals.find((r) => r.fatal);
  if (fatal) {
    return {
      ok: false,
      enabled: true,
      plugins,
      refusals,
      hookSpecs: [],
      error: `plugin "${fatal.name}" was refused: ${fatal.detail}`,
    };
  }

  return { ok: true, enabled: true, plugins, refusals, hookSpecs };
}

/**
 * One block for `--doctor`, and it says the negative cases in full.
 *
 * ⚠️ A ROSTER THAT ONLY LISTS WORKING PLUGINS CANNOT ANSWER THE ONLY QUESTION
 * ANYONE ASKS OF IT, which is "why is mine not doing anything".
 *
 * @param {ReturnType<typeof discoverPlugins>} found
 * @returns {{ state: 'live'|'dark'|'broken', line: string, fix: string|null }}
 */
export function describePlugins(found) {
  if (!found) return { state: 'dark', line: 'plugins: none', fix: null };
  if (found.enabled === false) {
    return { state: 'dark', line: `plugins: OFF — ${PLUGINS_ENV}=off`, fix: `unset ${PLUGINS_ENV} to load ${PLUGINS_CONFIG_FILE} again`, };
  }
  if (!found.ok) {
    return {
      state: 'broken',
      line: `plugins: REFUSED — ${found.error}`,
      fix: `fix ${PLUGINS_CONFIG_FILE} or the plugin's ${PLUGIN_MANIFEST}. Until then every session stops here, because a grant nobody can read cannot be honoured.`,
    };
  }
  const active = found.plugins.filter((p) => p.active.length > 0);
  const parts = [];
  for (const p of found.plugins) {
    parts.push(`${p.name}@${p.version} [${p.active.length ? `active: ${p.active.join(', ')}` : 'nothing granted'}${p.ungranted.length ? `; refused: ${p.ungranted.join(', ')}` : ''}${p.stale.length ? `; granted-but-unused: ${p.stale.join(', ')}` : ''}]`);
  }
  for (const r of found.refusals) {
    if (r.reason === 'not-enabled' || r.reason === 'missing') parts.push(`${r.name} [${r.reason}]`);
  }
  if (parts.length === 0) {
    return { state: 'dark', line: `plugins: none — a folder under ${PLUGINS_DIR}/ with an ${PLUGIN_MANIFEST}, enabled in ${PLUGINS_CONFIG_FILE}, can contribute ${PLUGIN_CAPABILITIES.join(', ')}`, fix: null };
  }
  return {
    state: active.length ? 'live' : 'dark',
    line: `plugins: ${parts.join(' · ')}`,
    fix: active.length ? null : `nothing is contributing — grant a capability in ${PLUGINS_CONFIG_FILE}, e.g. {"plugins":{"<name>":{"grant":["hooks"]}}}`,
  };
}
