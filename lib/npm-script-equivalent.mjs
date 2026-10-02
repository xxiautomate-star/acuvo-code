/**
 * ── ⭐⭐ A REFUSED npm SCRIPT MUST NAME THE COMMANDS THAT *ARE* ALLOWED ────────
 *
 * FOUND BY USING IT (2026-09-27), on a cloned MIT repo (`lukeed/tinydate`):
 *
 *     "pretest": "npm run build",   "build": "bundt",
 *     "test":    "tape test/*.js | tap-spec"
 *
 * `npm test` is refused — a script body may only run node, vitest or tsc — and
 * that is the right call: this validator does not follow `npm run` chains or
 * vouch for a pipe. But the refusal named a rule and no way out, so the run
 * spent 14 of its 29 rounds (and 10 minutes) hand-writing the build output and
 * a tape shim to prove its work, and still reported `npm test` as NOT RUNNABLE.
 *
 * ⚠️ AND THE WAY OUT ALREADY EXISTED. `node node_modules/tape/bin/tape
 * test/*.js` and `node node_modules/bundt/bin.js` pass `validateCommand` today.
 * A gate that is cheaper to route around than to satisfy is a signpost — this
 * file's own neighbour says so (`unknownBinaryRefusal`). So this module changes
 * WHAT A REFUSAL SAYS and nothing about what is allowed:
 *
 *   · every suggestion is re-checked by the SAME `validateCommand` the model's
 *     next call will hit, and a line that would itself be refused is never
 *     printed — a suggestion that bounces is worse than none;
 *   · `npm run <x>` / `npm test` inside a body is followed into that script
 *     (depth-bounded, cycle-checked), because the chain IS the build step;
 *   · `a && b` becomes two commands, in order;
 *   · `| reporter` is dropped and SAID to be dropped — a TAP pretty-printer
 *     only formats output, and the exit code comes from the left side;
 *   · a bin is resolved to a FILE through the package's own `bin` field in
 *     node_modules, never through PATH or `.bin` shims;
 *   · no node_modules at all → say so, and name the human's switch
 *     (`--allow-install`), since installing is not the model's call.
 *
 * Guard: `test/npm-script-equivalent.test.mjs`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
// ⚠️ No import of './command.mjs': command.mjs imports THIS file, and the
// cycle breaks the single-file publish bundle. The caller passes its validator.

const MAX_DEPTH = 4;
const PKG_NAME = /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i;

function readJson(abs) {
  try {
    return JSON.parse(readFileSync(abs, 'utf8'));
  } catch {
    return null;
  }
}

/** The file a bin name runs, relative to root, or null. PATH is never consulted. */
export function resolveBinFile(root, binName, pkg) {
  const deps = Object.keys({ ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) });
  // The package named like the bin first (tape, jest, bundt), then every declared dep.
  const candidates = [binName, ...deps.filter((d) => d !== binName)];
  for (const name of candidates) {
    if (!PKG_NAME.test(name)) continue;
    const manifest = readJson(join(root, 'node_modules', name, 'package.json'));
    if (!manifest || manifest.bin == null) continue;
    let rel = null;
    if (typeof manifest.bin === 'string' && (name === binName || name.endsWith(`/${binName}`))) rel = manifest.bin;
    else if (manifest.bin && typeof manifest.bin === 'object' && typeof manifest.bin[binName] === 'string') rel = manifest.bin[binName];
    if (!rel) continue;
    const clean = rel.replace(/^\.\//, '');
    if (clean.includes('..')) continue;
    const file = `node_modules/${name}/${clean}`;
    if (existsSync(join(root, file))) return file;
  }
  return null;
}

/**
 * @param {string} root workspace root
 * @param {string} scriptName the script that was refused ("test")
 * @param {(cmd: string) => {ok: boolean}} validate the same gate the model's commands pass (validateCommand)
 * @returns {string|null} one paragraph for the model, or null when there is nothing honest to say
 */
export function allowedEquivalentOfScript(root, scriptName, validate) {
  // Fail closed: with no gate to re-check a suggestion, suggest nothing.
  if (typeof validate !== 'function') return null;
  const pkg = readJson(join(root, 'package.json'));
  const scripts = pkg && typeof pkg.scripts === 'object' ? pkg.scripts : null;
  if (!scripts || typeof scripts[scriptName] !== 'string') return null;

  const commands = [];
  const dropped = [];
  const missing = [];
  const unresolved = [];

  const walk = (name, depth, seen) => {
    if (depth > MAX_DEPTH || seen.has(name)) { unresolved.push(`npm run ${name}`); return; }
    const next = new Set(seen).add(name);
    for (const link of [`pre${name}`, name, `post${name}`]) {
      if (typeof scripts[link] !== 'string') continue;
      for (const rawSeg of scripts[link].split('&&')) {
        let seg = rawSeg.trim();
        if (!seg) continue;
        const pipe = seg.indexOf('|');
        if (pipe !== -1) { dropped.push(seg.slice(pipe + 1).trim()); seg = seg.slice(0, pipe).trim(); }
        const tokens = seg.split(/\s+/);
        const [bin, ...rest] = tokens;
        if (bin === 'npm' && (rest[0] === 'test' || rest[0] === 't')) { walk('test', depth + 1, next); continue; }
        if (bin === 'npm' && (rest[0] === 'run' || rest[0] === 'run-script') && rest[1] && typeof scripts[rest[1]] === 'string') {
          walk(rest[1], depth + 1, next);
          continue;
        }
        let candidate = seg;
        if (!['node', 'vitest', 'tsc', 'npm', 'npx'].includes(bin)) {
          const file = resolveBinFile(root, bin, pkg);
          if (!file) { missing.push(bin); continue; }
          candidate = ['node', file, ...rest].join(' ');
        }
        const verdict = validate(candidate);
        if (verdict.ok) commands.push(candidate);
        else unresolved.push(seg);
      }
    }
  };
  walk(scriptName, 0, new Set());

  const noModules = !existsSync(join(root, 'node_modules'));
  const lines = [];
  if (commands.length && !missing.length && !unresolved.length) {
    lines.push(`The same work IS allowed as ${commands.length === 1 ? 'this command' : 'these commands, run in order'} (each bin resolved to its file in node_modules):`);
    commands.forEach((c, i) => lines.push(`  ${i + 1}. ${c}`));
    if (dropped.length) lines.push(`Dropped: the pipe into ${dropped.map((d) => `\`${d}\``).join(', ')} — a reporter only formats output; the exit code comes from the command before it.`);
    return lines.join('\n');
  }
  if (missing.length && noModules) {
    return `The script needs ${[...new Set(missing)].join(', ')}, and this workspace has no node_modules — its dependencies are not installed. Installing is the user's switch, not yours: tell them to re-run with \`acuvo --allow-install "<task>"\` (or ACUVO_ALLOW_INSTALL=1). Until then, say plainly that the project's own test command could not run.`;
  }
  if (missing.length) {
    return `The script runs ${[...new Set(missing)].join(', ')}, which is not installed in node_modules here, so there is no allowed equivalent to offer.`;
  }
  return null;
}
