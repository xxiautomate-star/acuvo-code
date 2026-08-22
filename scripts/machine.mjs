#!/usr/bin/env node
/**
 * ── ⚠️⚠️ THIS EXISTS BECAUSE A BENCHMARK RUN MADE THE OWNER'S LAPTOP UNUSABLE ─
 *
 * 2026-08-12, verbatim: *"we have to figure out a way to stop hammering my
 * laptop dude, it's fucked. I cannot even watch Netflix, I can't even change
 * tabs."* A Terminal-Bench run had twenty Docker containers on an 8-core machine
 * with no `.wslconfig`, so WSL2 — which is what Docker Desktop runs on — helped
 * itself to every logical processor and most of the RAM.
 *
 * ⭐ AND THE INSTRUCTION WAS NOT "DO LESS WORK." It was *"that doesn't mean
 * workload goes lower, we need to be able to control my laptop."* So this is
 * about a CEILING and a KILL SWITCH, never about scaling ambition down. Heavy
 * work runs flat out inside a box it cannot climb out of.
 *
 * ── THE THREE CONTROLS, IN ORDER OF HOW MUCH THEY MATTER ────────────────────
 *
 *   1. `~/.wslconfig` — the real one. Caps the VM at 4 of 8 processors and 6GB.
 *      Without it there is no limit at all, which is the state this machine was
 *      in. ⚠️ Needs `wsl --shutdown` to take effect; editing it does nothing to
 *      a VM already running.
 *   2. Priority — our long jobs run BELOW NORMAL, so the desktop always wins a
 *      contested core. A build that takes 10% longer and never stutters the UI
 *      is the correct trade on somebody's personal machine.
 *   3. This script — `status` to see what we are costing, `stop` to end all of
 *      it in one command, without hunting pids.
 *
 * Zero dependencies, like everything else here.
 *
 *   node scripts/machine.mjs status
 *   node scripts/machine.mjs stop
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const WSLCONFIG = join(homedir(), '.wslconfig');

/** Processes that are OURS and heavy. Never the user's editor or browser. */
const OURS = /harbor|acuvo|terminal-bench/i;

function sh(file, args, { quiet = false } = {}) {
  try {
    return execFileSync(file, args, {
      encoding: 'utf8', timeout: 20_000, windowsHide: true,
      stdio: quiet ? ['ignore', 'pipe', 'ignore'] : ['ignore', 'pipe', 'inherit'],
    });
  } catch (e) {
    return e?.stdout ?? '';
  }
}

function dockerContainers() {
  const out = sh('docker', ['ps', '--format', '{{.ID}}\t{{.Names}}\t{{.Image}}'], { quiet: true });
  return out.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const [id, name, image] = l.split('\t');
    return { id, name, image };
  });
}

/**
 * ⚠️ `docker stats` WITHOUT `--no-stream`, ON WINDOWS, NEVER RETURNS. It streams
 * until interrupted, and a script that hangs while you are trying to reclaim
 * your machine is the opposite of this file's job.
 */
function dockerLoad() {
  const out = sh('docker', ['stats', '--no-stream', '--format', '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}']);
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

function wslCap() {
  if (!existsSync(WSLCONFIG)) {
    return {
      ok: false,
      detail: 'NO ~/.wslconfig — WSL2 (and therefore Docker) may take EVERY core and most of your RAM. '
        + 'This is the state that made the machine unusable.',
    };
  }
  const text = readFileSync(WSLCONFIG, 'utf8');
  const procs = /processors\s*=\s*(\d+)/i.exec(text)?.[1] ?? null;
  const mem = /memory\s*=\s*(\S+)/i.exec(text)?.[1] ?? null;
  return {
    ok: procs !== null && mem !== null,
    procs,
    mem,
    detail: procs && mem
      ? `capped at ${procs} processors and ${mem}`
      : 'present but does not set BOTH processors and memory — the unset one is uncapped',
  };
}

function heavyProcesses() {
  // ⚠️ Windows only, and it fails quietly elsewhere rather than pretending.
  if (process.platform !== 'win32') return [];
  /**
   * ⚠️⚠️ IT MATCHED ITSELF. The query's OWN command line contains the words it
   * searches for, so every `status` reported one phantom powershell.exe and told
   * the owner something of ours was still running when the machine was idle. A
   * monitor that cannot report "all clear" is worse than no monitor — this one
   * exists precisely to be believed.
   *
   * Excluded by pid (our own child) and by the give-away that only the detector
   * mentions BOTH patterns in one command line.
   */
  const ps = sh('powershell', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'harbor|terminal-bench' } "
    + '| Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress'], { quiet: true });
  try {
    const parsed = JSON.parse(ps || '[]');
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.filter((p) => {
      if (!p || p.ProcessId === process.pid) return false;
      const cl = String(p.CommandLine ?? '');
      // The detector is the only thing that names both patterns at once.
      return !(cl.includes('harbor|terminal-bench'));
    });
  } catch { return []; }
}

function status() {
  const cap = wslCap();
  console.log('');
  console.log(`  WSL / Docker ceiling   ${cap.ok ? '✔' : '✖'}  ${cap.detail}`);
  if (!cap.ok) {
    console.log('                         → write ~/.wslconfig with processors= and memory=, then `wsl --shutdown`');
  }

  const containers = dockerContainers();
  console.log(`  containers running     ${containers.length === 0 ? '✔  none' : `⚠  ${containers.length}`}`);
  for (const c of containers) console.log(`                           ${c.name}  (${c.image})`);

  if (containers.length > 0) {
    for (const line of dockerLoad()) console.log(`                           ${line}`);
  }

  const procs = heavyProcesses();
  console.log(`  our heavy processes    ${procs.length === 0 ? '✔  none' : `⚠  ${procs.length}`}`);
  for (const p of procs) console.log(`                           pid ${p.ProcessId}  ${p.Name}`);

  const quiet = containers.length === 0 && procs.length === 0;
  console.log('');
  console.log(quiet
    ? '  Nothing of ours is running. The machine is yours.'
    : '  Run `node scripts/machine.mjs stop` to end all of it.');
  console.log('');
  return quiet ? 0 : 1;
}

function stop() {
  /**
   * ⚠️ CONTAINERS FIRST, THEN THE ORCHESTRATOR. Killing harbor first leaves its
   * containers running with nothing supervising them — orphans, which is the
   * exact failure `background.mjs` was written to avoid, at a larger size.
   */
  const containers = dockerContainers();
  if (containers.length > 0) {
    console.log(`  killing ${containers.length} container${containers.length === 1 ? '' : 's'}…`);
    spawnSync('docker', ['kill', ...containers.map((c) => c.id)], { stdio: 'ignore', timeout: 60_000, windowsHide: true });
  }

  const procs = heavyProcesses();
  for (const p of procs) {
    console.log(`  killing pid ${p.ProcessId} (${p.Name})…`);
    spawnSync('taskkill', ['/T', '/F', '/PID', String(p.ProcessId)], { stdio: 'ignore', timeout: 30_000, windowsHide: true });
  }

  /**
   * ⭐ AND THE VM ITSELF, because a shut-down WSL2 releases its RAM immediately
   * instead of holding it until the next reboot. This is the line that actually
   * gives the memory back.
   */
  console.log('  shutting down the WSL VM to release its memory…');
  spawnSync('wsl', ['--shutdown'], { stdio: 'ignore', timeout: 60_000, windowsHide: true });

  console.log('');
  console.log('  Done. The machine is yours.');
  return 0;
}

/**
 * ── ⭐ RUN SOMETHING HEAVY WITHOUT IT OWNING THE MACHINE ────────────────────
 *
 * `machine.mjs run -- <command…>` starts a command at BELOW NORMAL priority, so
 * the desktop wins every contested core. A benchmark that takes 10% longer and
 * never stutters a video is the correct trade on somebody's personal laptop —
 * and it is the difference between "workload goes lower" (which was explicitly
 * NOT the instruction) and "workload stays out of your way".
 *
 * ⚠️ PRIORITY IS NOT A SUBSTITUTE FOR THE `.wslconfig` CAP. Docker's work does
 * not happen in the child we launch; it happens inside the WSL VM, which this
 * cannot reach. Both controls are needed and they cover different things:
 * priority governs OUR processes, the cap governs the VM.
 */
function runLow(argv) {
  if (argv.length === 0) {
    console.error('usage: node scripts/machine.mjs run -- <command> [args…]');
    return 64;
  }
  const cap = wslCap();
  if (!cap.ok) {
    // ⚠️ Refuse rather than warn. This is the exact configuration that made the
    // machine unusable, and a warning at the top of a two-hour run is a warning
    // nobody is present to read.
    console.error(`  ✖ refusing to start heavy work: ${cap.detail}`);
    console.error('    Write ~/.wslconfig with processors= and memory=, then `wsl --shutdown`.');
    return 1;
  }
  console.log(`  starting at BELOW NORMAL priority (VM ${cap.detail})`);
  const r = process.platform === 'win32'
    ? spawnSync('cmd', ['/c', 'start', '/b', '/belownormal', '/wait', ...argv], { stdio: 'inherit', windowsHide: true })
    : spawnSync('nice', ['-n', '15', ...argv], { stdio: 'inherit' });
  return r.status ?? 0;
}

const cmd = process.argv[2] ?? 'status';
if (cmd === 'stop' || cmd === 'panic' || cmd === 'kill') process.exit(stop());
else if (cmd === 'status') process.exit(status());
else if (cmd === 'run') {
  const sep = process.argv.indexOf('--');
  process.exit(runLow(sep === -1 ? process.argv.slice(3) : process.argv.slice(sep + 1)));
} else {
  console.error('usage: node scripts/machine.mjs [status|stop|run -- <cmd>]');
  process.exit(64);
}
