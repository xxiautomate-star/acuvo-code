/**
 * ── ⭐⭐⭐ CLI ACCEPTANCE ITEM #1, MEASURED END TO END, FOR $0.00 ────────────
 *
 * Roman's six-point definition of CLI-done opens with *"caching solid EVEN WHEN
 * MODELS SWITCH"*, and CLAUDE.md still records it as the one that is open.
 *
 * ⚠️ WHAT CANNOT BE FIXED, STATED FIRST. A prefix cache is a KV store on one
 * upstream host. Switching providers starts cold; that is physics. This probe
 * does not pretend otherwise and does not measure it.
 *
 * ⭐ WHAT IT DOES MEASURE IS THE HALF WE OWN, ON THE REAL CODE PATH: the actual
 * `runSession` loop, the actual `callChain`, the actual `callModel` wire body,
 * with only `fetch` replaced. For every round it reads off the wire:
 *
 *     the model asked for          the `provider` block (the warm lock)
 *     the sticky `session_id`      the shared prefix with the previous round
 *
 * and it drives the case that matters — the primary dies mid-session and the
 * chain moves to another model — because a switch happens on a FALLBACK, which
 * is exactly when nobody is watching.
 *
 * ⚠️ IT IS A PROBE, NOT A GUARD. It prints; it asserts nothing. The guard that
 * holds the prefix is `test/cache-survives-model-switch.test.mjs`; the guard
 * that holds the finding below is `test/the-warm-lock-after-a-switch.test.mjs`.
 *
 *     node scripts/zz-cache-across-a-model-switch.mjs
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSession } from '../lib/turn.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';
import { callChain } from '../lib/chain.mjs';
import { callModel } from '../lib/model.mjs';

const PRIMARY = 'deepseek/deepseek-v4-flash-0731';
/** The chain's own floor model — `buildChain` appends it, we do not invent it. */
const FALLBACK = 'z-ai/glm-4.6';
/** How many rounds keep calling a tool, so the run continues past the switch. */
const TOOL_ROUNDS = 5;

const made = [];
function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-switch-probe-'));
  made.push(root);
  writeFileSync(join(root, 'package.json'), '{"name":"c","version":"1.0.0"}\n');
  writeFileSync(join(root, 'a.js'), 'export const a = 1;\n');
  return root;
}

/** Shared leading characters — the ONLY quantity a prefix cache pays for. */
function sharedPrefix(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  return i;
}

/**
 * ⚠️ THE SAME SERIALISATION THE TWO CACHE TESTS USE. `JSON.stringify(messages)`
 * makes round N end with `]` while round N+1 continues `},{`, so a perfectly
 * stable prefix reads as one changed character — an instrument artefact shaped
 * exactly like the defect it hunts.
 */
function serialise(messages) {
  return (messages ?? []).map((m) => [
    m.role,
    typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    m.tool_calls ? JSON.stringify(m.tool_calls) : '',
    m.tool_call_id ?? '',
  ].join(' ')).join('');
}

/**
 * The scripted upstream. `deepseek/*` 429s from round 2 onward — the ordinary
 * shape of a real fallback — and everything else answers.
 *
 * ⚠️ IT RETURNS A `provider` FIELD, because that is what `learnFromRound` reads.
 * A stub that omits it teaches the warm lock nothing and the probe would report
 * a cold session that production never has.
 */
function upstream(rounds) {
  let n = 0;
  return async (_url, opts) => {
    const body = JSON.parse(opts.body);
    n += 1;
    rounds.push({
      call: n,
      model: body.model,
      provider: body.provider ? JSON.stringify(body.provider) : null,
      sessionId: body.session_id ?? null,
      wire: `${JSON.stringify(body.tools ?? null)}\n${serialise(body.messages)}`,
    });
    const isPrimary = String(body.model).startsWith('deepseek/');
    if (isPrimary && rounds.filter((r) => r.model === body.model).length > 1) {
      rounds[rounds.length - 1].ok = false;
      return {
        ok: false,
        status: 429,
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify({ error: { message: 'rate limited' } }),
        json: async () => ({ error: { message: 'rate limited' } }),
      };
    }
    /**
     * ⚠️ IT MUST KEEP CALLING TOOLS. A bare `stop` ends the session, and the
     * first version of this probe answered `stop` on round 2 — so it observed
     * exactly ONE round after the switch and could not see what the remaining
     * rounds of a fallen-back session route on, which is the whole question.
     */
    const answered = rounds.filter((r) => r.ok !== false).length;
    const first = answered <= TOOL_ROUNDS;
    return {
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({
        choices: [{
          message: {
            content: first ? 'reading' : 'done',
            tool_calls: first
              ? [{ id: `c${n}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'a.js' }) } }]
              : undefined,
          },
          finish_reason: 'stop',
        }],
        model: body.model,
        provider: String(body.model).startsWith('deepseek/') ? 'Relace' : 'DeepInfra',
        usage: { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010 },
      }),
    };
  };
}

async function main() {
  const root = workspace();
  const rounds = [];
  const fetchImpl = upstream(rounds);

  /**
   * ⚠️ A THROWAWAY HOME. `saveWarmth` writes under `$ACUVO_HOME` and a probe has
   * no business in the developer's real `~/.acuvo` — `scripts/test.mjs` makes
   * the same argument at length for the suite.
   */
  const home = mkdtempSync(join(tmpdir(), 'acuvo-probe-home-'));
  made.push(home);
  process.env.ACUVO_HOME = home;

  await runSession({
    task: 'look at a.js and say what it exports',
    executor: createLocalExecutor(root),
    config: { apiKey: 'k', model: PRIMARY },
    maxRounds: 8,
    allowRun: false,
    /**
     * ⚠️ `fetchImpl` DOES NOT REACH `callModel` THROUGH `callChain`. The chain
     * forwards a fixed field list to `callImpl`, and `fetchImpl` is not in it —
     * the first version of this probe passed it and recorded ZERO rounds, which
     * read exactly like "the session never ran". Injecting at `callImpl` is the
     * seam the chain actually offers.
     */
    callModelImpl: (o) => callChain({
      ...o,
      sleepImpl: async () => {},
      callImpl: (c) => callModel({ ...c, fetchImpl }),
    }),
    onEvent: () => {},
  });

  const line = (s) => process.stdout.write(`${s}\n`);
  line('');
  line('── THE WIRE, ROUND BY ROUND ────────────────────────────────────────');
  line('');
  line('  #  model                              provider block                     prefix vs prev');
  for (let i = 0; i < rounds.length; i += 1) {
    const r = rounds[i];
    const prev = i > 0 ? rounds[i - 1].wire : null;
    const share = prev ? `${((sharedPrefix(prev, r.wire) / Math.max(prev.length, r.wire.length)) * 100).toFixed(1)}%` : '—';
    line(`  ${String(r.call).padEnd(2)} ${String(r.model).padEnd(34)} ${String(r.provider ?? 'none').padEnd(34)} ${share}`);
  }
  line('');
  const ids = new Set(rounds.map((r) => r.sessionId));
  line(`  session_id values across the whole run: ${ids.size} (${[...ids].map((v) => (v ? 'set' : 'ABSENT')).join(', ')})`);
  line('');
  line('── WHAT IT MEANS ───────────────────────────────────────────────────');
  line('');
  const locked = rounds.filter((r) => r.provider && r.provider.includes('"only"'));
  line(`  rounds carrying a warm LOCK (provider.only):        ${locked.length} of ${rounds.length}`);
  const onFallback = rounds.filter((r) => r.model === FALLBACK);
  const lockedOnFallback = onFallback.filter((r) => r.provider && r.provider.includes('"only"'));
  line(`  rounds served by the fallback model:                ${onFallback.length}`);
  line(`  ...of those, carrying a warm lock:                  ${lockedOnFallback.length}`);
  line('');
  rmSync(home, { recursive: true, force: true });
  for (const d of made) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
}

main().catch((e) => { process.stderr.write(`${e?.stack ?? e}\n`); process.exit(1); });
