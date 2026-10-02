/**
 * ── ⭐⭐⭐ THE BENCH KEPT MEASURING DOCKER, NOT THE AGENT ────────────────────
 *
 * Measured on our own runs: `deep100` attempted 89 tasks, scored 16, and lost
 * **63 to a single fact** — `RuntimeError: Docker compose command failed`, the
 * daemon collapsing under concurrent containers on a Windows laptop. `run-fixed`
 * lost 71 the same way. Every "score" quoted from those runs was arithmetic over
 * the survivors.
 *
 * ⚠️ AND THE LOSS IS SILENT IN THE WORST WAY: a crashed trial writes
 * `exception.txt` and no `reward.txt`, so it is neither a pass nor a fail. It
 * simply is not there. A run can look 37.5% while three quarters of it never
 * started.
 *
 * ⭐ THIS TURNS THAT INTO A RETRY LIST. A Docker collapse is a HOST failure, not
 * a result: the honest response is to run those tasks again, not to publish a
 * percentage that quietly excluded them. Usage:
 *
 *     node retry-crashed.mjs results/deep100            # what to re-run, and why
 *     node retry-crashed.mjs results/deep100 --command  # the harbor line to paste
 *
 * ⚠️ IT DOES NOT RUN ANYTHING ITSELF. Launching a benchmark costs money and
 * hours of a machine Roman is also using; printing the command keeps the
 * decision with the person whose laptop it is.
 *
 * Zero dependencies, like everything else here.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Failures that are the HOST giving up rather than the agent being wrong.
 *
 * ⚠️ THE LIST IS DELIBERATELY NARROW. Re-running a task that genuinely failed
 * would inflate the score, which is the opposite of the honesty this whole file
 * exists for. Everything here is an infrastructure error that produced no
 * verdict at all.
 */
const HOST_FAILURES = [
  // The Windows Docker Desktop collapse — 63 of 73 losses in one run.
  /Docker compose command failed/i,
  // 0xC0000142: a container process that could not initialise at all.
  /3221225794/,
  /EnvironmentStartTimeoutError/i,
  /Cannot connect to the Docker daemon/i,
  /docker: error during connect/i,
  /no space left on device/i,
  /failed to solve/i,
];

/** Did this trial die on the host, and if so, why? */
export function classifyTrial(dir) {
  let reward = null;
  try { reward = readFileSync(join(dir, 'verifier', 'reward.txt'), 'utf8').trim(); } catch { /* unscored */ }
  if (reward !== null) return { scored: true, passed: Number(reward) >= 1 };

  let text = '';
  try { text = readFileSync(join(dir, 'exception.txt'), 'utf8'); } catch { return { scored: false, pending: true }; }

  const matched = HOST_FAILURES.find((re) => re.test(text));
  /**
   * ⚠️ AN UNRECOGNISED CRASH IS NOT AUTOMATICALLY RETRYABLE. It might be our
   * agent hanging, and re-running it would spend money to reproduce a real
   * failure. Reported separately so it can be read rather than assumed.
   */
  const last = text.split('\n').filter((l) => l.trim()).pop() ?? '';
  return { scored: false, crashed: true, hostFailure: Boolean(matched), reason: last.slice(0, 100) };
}

/** The task name, recovered from the trial directory (`task__hash`). */
export function taskOf(entry) {
  return String(entry).split('__')[0];
}

export function survey(dir) {
  const out = { scored: 0, passed: 0, retryable: [], unclear: [], pending: 0 };
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    try { if (!statSync(path).isDirectory()) continue; } catch { continue; }
    const verdict = classifyTrial(path);
    if (verdict.scored) {
      out.scored += 1;
      if (verdict.passed) out.passed += 1;
    } else if (verdict.pending) {
      out.pending += 1;
    } else if (verdict.hostFailure) {
      out.retryable.push({ task: taskOf(name), reason: verdict.reason });
    } else {
      out.unclear.push({ task: taskOf(name), reason: verdict.reason });
    }
  }
  return out;
}

/**
 * ⚠️ DEDUPED. The same task can crash more than once in a run, and a retry list
 * that names it twice runs it twice.
 */
export function retryTasks(out) {
  return [...new Set(out.retryable.map((r) => r.task))].sort();
}

function main() {
  const dir = process.argv[2];
  if (!dir) {
    process.stdout.write('usage: node retry-crashed.mjs <results-dir> [--command]\n');
    process.exit(2);
  }
  const out = survey(dir);
  const tasks = retryTasks(out);

  if (process.argv.includes('--command')) {
    if (tasks.length === 0) { process.stdout.write('nothing to retry\n'); return; }
    /**
     * ⭐ `-n 1`. The collapse this exists to repair was caused by concurrency;
     * retrying at the same concurrency reproduces it. Slower and finished beats
     * faster and lost.
     */
    process.stdout.write([
      'harbor run \\',
      '  -d terminal-bench/terminal-bench-2-1 \\',
      '  --agent-import-path acuvo_terminal_bench:AcuvoAgent \\',
      '  --jobs-dir ./results \\',
      '  -n 1 \\',
      tasks.map((t) => `  -t ${t}`).join(' \\\n'),
      '',
    ].join('\n'));
    return;
  }

  const total = out.scored + out.retryable.length + out.unclear.length + out.pending;
  process.stdout.write([
    '',
    `  ${dir}`,
    `  ${out.passed}/${out.scored} scored trials passed, of ${total} attempted`,
    '',
    `  ${tasks.length} task${tasks.length === 1 ? '' : 's'} died on the HOST and should be re-run:`,
    ...tasks.slice(0, 12).map((t) => `    ${t}`),
    tasks.length > 12 ? `    …and ${tasks.length - 12} more` : '',
    '',
    out.unclear.length
      ? `  ⚠ ${out.unclear.length} crashed for reasons that are NOT clearly the host — read these before retrying:\n`
        + out.unclear.slice(0, 5).map((u) => `    ${u.task}: ${u.reason}`).join('\n')
      : '  no unexplained crashes',
    '',
    '  Re-run them:  node retry-crashed.mjs ' + dir + ' --command',
    '',
  ].filter((l) => l !== '').join('\n'));
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('retry-crashed.mjs')) main();
