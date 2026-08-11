/**
 * ── ⭐⭐ SEVEN TERMINALS, ONE CHECKOUT — A COOPERATIVE FILE LEASE ────────────
 *
 * `lib/parallel.mjs` coordinates tasks inside ONE process: it runs them in a
 * pool and, crucially, DETECTS when two of them wrote the same file. Seven
 * separate `acuvo` processes on one machine share no memory at all, so that
 * detection cannot see across them. Two terminals will eventually write the
 * same file, the second one wins silently, and the first reports success for
 * work that no longer exists.
 *
 * This file is the missing coordination: a lease taken on a PATH, published on
 * disk, visible to every process in the checkout.
 *
 * ── ⚠️ FOUR DESIGN DECISIONS, AND WHY THEY WENT THIS WAY ────────────────────
 *
 * 1. **PATHS, NOT THE REPO.** A repo-wide lock idles six of seven terminals,
 *    which deletes the entire point of running seven. A terminal declares the
 *    handful of files it intends to write; everything else stays free.
 *
 * 2. **A TTL PLUS A HEARTBEAT, AND A RECLAIM THAT IS DELIBERATELY SLOW.** A
 *    crashed terminal must not block the repo for ever, so a lease goes stale.
 *    But reclaiming EAGERLY is strictly worse than deadlocking: a deadlock is a
 *    refusal a human can read, while an early reclaim hands two live agents the
 *    same file and corrupts the work invisibly. So the reclaim boundary is the
 *    TTL *plus another whole TTL* (never less than the grace period), and the
 *    takeover is written into the record so it can be seen afterwards.
 *
 * 3. **CONSERVATIVE KEYS.** `src/App.ts` and `src/app.ts` are ONE file on
 *    Windows and macOS. Keying on the exact spelling would hand two agents the
 *    same file on the machine this actually runs on. Over-locking costs one
 *    refusal you can read; under-locking costs corruption you cannot see.
 *
 * 4. **EXCLUSIVITY COMES FROM THE FILESYSTEM, NEVER FROM A READ-THEN-WRITE.**
 *    Checking "is it free?" and then writing is a race with a window, and eight
 *    processes will find that window. Creating a file is the only operation the
 *    OS will do exactly once, so every lease is *published* by an exclusive
 *    create (hard link, falling back to O_EXCL) and every *replacement* is
 *    serialised behind an exclusively-created gate and lands by rename. A
 *    reader therefore only ever sees "no file" or "the whole file" — never the
 *    half a file a killed process would otherwise leave behind.
 *
 * ⚠️ NO AMBIENT TIME. The wall clock is injected exactly once, as a default.
 * Every TTL decision in here is a pure function of a number that a test can
 * hand over, which is why the whole TTL surface tests in microseconds.
 */

import { createHash } from 'node:crypto';
import {
  linkSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

/** Bump when the on-disk shape changes; an unknown version reads as corrupt. */
export const LEASE_VERSION = 1;

/** Where lease records live, relative to the workspace root. Always '/'-joined. */
export const LEASE_DIR = '.acuvo/leases';

/**
 * ⚠️ THE TTL BAND. A lease shorter than a second cannot be heartbeated
 * reliably, and one longer than an hour is a crashed terminal nobody notices.
 */
export const MIN_TTL_MS = 1_000;
export const DEFAULT_TTL_MS = 120_000;
export const MAX_TTL_MS = 3_600_000;

/**
 * ⚠️ THE FLOOR ON PATIENCE. Even a one-second lease gets this long of silence
 * before anyone may take it — long enough that a garbage-collection pause or a
 * slow disk cannot look like a dead terminal.
 */
export const RECLAIM_GRACE_MS = 30_000;

/** A hot path could be taken over for ever; the record must not grow for ever. */
export const MAX_TAKEOVERS = 8;

/**
 * ⚠️ THE ONE AND ONLY READ OF AMBIENT TIME IN THIS MODULE. Everything else
 * takes `clock` as a parameter. A test pins this by counting occurrences, and
 * that test is the reason every TTL case here runs without a single sleep.
 */
const wallClock = () => Date.now();

/** Link failures that mean "this filesystem cannot", not "somebody beat you". */
const LINK_UNSUPPORTED = new Set(['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EMLINK']);

/** Windows can transiently refuse a rename while another process reads the file. */
const RENAME_RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_ATTEMPTS = 25;

// ═══════════════════════════════════════════════════════════════════════════
// PURE HELPERS — no disk, no time, no exceptions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * How long a lease must be SILENT before anybody else may take it.
 *
 * ⭐ Doubling rather than adding a fixed grace is the conservative choice: a
 * ten-minute lease is held by something slow and deliberate, and giving it only
 * thirty extra seconds would reclaim it out from under real work. A short lease
 * still gets the full grace period, so nothing is ever taken in under 30s.
 */
export function reclaimableAfter(ttlMs) {
  const ttl = Number.isFinite(ttlMs) ? Math.max(0, ttlMs) : DEFAULT_TTL_MS;
  return ttl + Math.max(RECLAIM_GRACE_MS, ttl);
}

/** `live` | `expired` (past TTL, still protected) | `reclaimable` (takeable). */
function stateOf(silentForMs, ttlMs) {
  if (silentForMs > reclaimableAfter(ttlMs)) return 'reclaimable';
  if (silentForMs > ttlMs) return 'expired';
  return 'live';
}

function clampTtl(ttlMs) {
  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs)) return DEFAULT_TTL_MS;
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Math.round(ttlMs)));
}

/**
 * ⚠️ A BROKEN CLOCK MUST BE AN ERROR, NEVER A RECORD. A lease whose timestamp
 * is NaN compares false against every boundary, so it would be simultaneously
 * un-expirable and un-reclaimable — a file locked for the life of the checkout.
 */
function checkClock(clock) {
  if (typeof clock !== 'function') {
    return { ok: false, error: 'clock must be a function returning a millisecond number' };
  }
  let now;
  try {
    now = clock();
  } catch (err) {
    return { ok: false, error: `clock threw: ${err?.message ?? String(err)}` };
  }
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    return { ok: false, error: `clock returned ${JSON.stringify(now) ?? String(now)} — a lease needs a finite millisecond number` };
  }
  return { ok: true, now };
}

/** An anonymous lock cannot be released by its owner or blamed for a stall. */
function checkHolder(holder) {
  if (typeof holder !== 'string' || !holder.trim()) {
    return { ok: false, error: 'a lease needs a holder name — an anonymous lock cannot be released, renewed or blamed' };
  }
  return { ok: true, holder: holder.trim() };
}

function normalizePid(pid) {
  return Number.isFinite(pid) ? Math.trunc(pid) : process.pid;
}

/**
 * Turn whatever the caller typed into ONE canonical repo-relative path.
 *
 * ⚠️ `./src/app.ts`, `src\app.ts` and `src/./app.ts` are the same file, and a
 * lease keyed on the raw string would let a second terminal walk straight past
 * a held lease by spelling it differently.
 */
function normalizePath(root, raw) {
  if (typeof root !== 'string' || !root.trim()) {
    return { ok: false, error: 'a workspace root is required' };
  }
  if (typeof raw !== 'string') {
    return { ok: false, error: `a lease path must be a string, got ${raw === null ? 'null' : typeof raw}` };
  }
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: 'a lease path must not be empty' };

  // ⚠️ A drive-letter path is absolute on Windows and merely odd on Linux —
  // reject it explicitly so the rule is the same on both.
  if (isAbsolute(trimmed) || /^[a-zA-Z]:[\\/]/.test(trimmed)) {
    return { ok: false, error: `a lease path must be relative to the workspace, got "${raw}"` };
  }

  const rootAbs = resolve(root);
  const absolute = resolve(rootAbs, trimmed);
  if (absolute === rootAbs) {
    return { ok: false, error: 'the workspace root itself cannot be leased — lease the paths you intend to write' };
  }
  if (!absolute.startsWith(rootAbs + sep)) {
    return { ok: false, error: `"${raw}" resolves outside the workspace and cannot be leased` };
  }

  const path = absolute.slice(rootAbs.length + 1).split(sep).join('/');
  return { ok: true, path, key: path.toLowerCase(), absolute };
}

/**
 * The record filename. A hash keeps nested paths flat and legal on every
 * filesystem, and hashing the CASE-FOLDED key is what makes `App.ts` and
 * `app.ts` collide on purpose.
 */
function recordName(key) {
  return `${createHash('sha256').update(key).digest('hex').slice(0, 20)}.json`;
}

/**
 * ⭐ A TOKEN IS DERIVED, NOT RANDOM. Proof of ownership has to survive being
 * written to disk and read back by another process, and a reproducible token
 * means a test can assert on it. Holder names collide (every terminal defaults
 * to the same one); holder + pid + path + instant does not.
 */
function deriveToken({ path, holder, pid, acquiredAt }) {
  return createHash('sha256')
    .update(`${LEASE_VERSION}\u0000${path}\u0000${holder}\u0000${pid}\u0000${acquiredAt}`)
    .digest('hex')
    .slice(0, 24);
}

/** Where a lease for `path` lives. Exported so callers can inspect one file. */
export function leaseFilePath(root, path) {
  const norm = normalizePath(root, path);
  if (!norm.ok) return norm;
  const dir = join(resolve(root), ...LEASE_DIR.split('/'));
  const name = recordName(norm.key);
  return { ok: true, path: norm.path, key: norm.key, target: norm.absolute, dir, name, absolute: join(dir, name) };
}

// ═══════════════════════════════════════════════════════════════════════════
// THE RECORD
// ═══════════════════════════════════════════════════════════════════════════

const serialize = (record) => `${JSON.stringify(record, null, 2)}\n`;

/**
 * ⚠️ A PARTIAL OR UNKNOWN RECORD IS NOT A LOCK. Every field is checked, because
 * the one thing worse than a corrupt lease file is a corrupt lease file that
 * still answers "held" and blocks the path for ever.
 */
function parseRecord(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, why: 'the file is empty' };
  let rec;
  try {
    rec = JSON.parse(raw);
  } catch {
    return { ok: false, why: 'the file is not valid JSON' };
  }
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return { ok: false, why: 'the file is not a lease object' };
  if (rec.version !== LEASE_VERSION) return { ok: false, why: `unknown lease version ${JSON.stringify(rec.version)}` };
  for (const field of ['path', 'key', 'holder', 'token']) {
    if (typeof rec[field] !== 'string' || !rec[field]) return { ok: false, why: `the "${field}" field is missing` };
  }
  for (const field of ['ttlMs', 'acquiredAt', 'renewedAt']) {
    if (typeof rec[field] !== 'number' || !Number.isFinite(rec[field])) return { ok: false, why: `the "${field}" field is missing or not a number` };
  }
  if (!Number.isFinite(rec.pid)) return { ok: false, why: 'the "pid" field is missing or not a number' };
  if (!Array.isArray(rec.takeovers)) return { ok: false, why: 'the "takeovers" field is missing' };
  return { ok: true, record: rec };
}

/** `absent` | `held` | `corrupt` | `unreadable`. Never throws. */
function readLeaseFile(absolute) {
  let raw;
  try {
    raw = readFileSync(absolute, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return { state: 'absent' };
    // ⚠️ Deliberately NOT treated as free. We cannot prove nobody holds it, and
    // guessing "free" is the failure that corrupts work. A human can read this.
    return { state: 'unreadable', why: err?.message ?? String(err) };
  }
  const parsed = parseRecord(raw);
  if (!parsed.ok) return { state: 'corrupt', why: parsed.why };
  return { state: 'held', record: parsed.record };
}

// ═══════════════════════════════════════════════════════════════════════════
// ATOMIC PUBLISH — the only two ways bytes ever reach a lease file
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create `target` with `data`, or fail because it already exists. This is the
 * whole mutual-exclusion primitive.
 *
 * ⭐ HARD LINK FIRST, O_EXCL SECOND. `link()` is the classic exclusive create
 * that stays correct on network filesystems where `O_EXCL` historically is not,
 * and it publishes a file that is COMPLETE at the instant it becomes visible —
 * the content is written to the temp name first, so no reader can ever observe
 * a half-written lease. The `O_EXCL` fallback exists for filesystems that
 * refuse links at all, and is still exclusive.
 */
function exclusiveCreate(target, data, linkImpl, pid) {
  const temp = `${target}.mk-${pid}`;
  try {
    writeFileSync(temp, data, 'utf8');
  } catch (err) {
    return { ok: false, error: `could not stage ${temp}: ${err?.message ?? String(err)}` };
  }
  try {
    linkImpl(temp, target);
    return { ok: true, via: 'link' };
  } catch (err) {
    if (err?.code === 'EEXIST') return { ok: false, taken: true };
    if (!LINK_UNSUPPORTED.has(err?.code)) return { ok: false, error: err?.message ?? String(err) };
    // fall through: this filesystem cannot link, so try an exclusive open
  } finally {
    try { unlinkSync(temp); } catch { /* the link succeeded or never happened */ }
  }
  try {
    writeFileSync(target, data, { encoding: 'utf8', flag: 'wx' });
    return { ok: true, via: 'wx' };
  } catch (err) {
    if (err?.code === 'EEXIST') return { ok: false, taken: true };
    return { ok: false, error: err?.message ?? String(err) };
  }
}

/** Rename, retrying the transient Windows sharing failures. No sleeping. */
function renameWithRetry(from, to) {
  let last;
  for (let i = 0; i < RENAME_ATTEMPTS; i++) {
    try {
      renameSync(from, to);
      return { ok: true };
    } catch (err) {
      last = err;
      if (!RENAME_RETRYABLE.has(err?.code)) break;
    }
  }
  return { ok: false, error: last?.message ?? String(last) };
}

/**
 * Replace an EXISTING lease record — renew, re-acquire, or take over.
 *
 * ⚠️ THIS IS THE DANGEROUS DIRECTION, so it is serialised. Eight processes that
 * all read the same stale record would all decide "I may take this"; the gate
 * is a shared filename that exactly one of them can create, and the winner
 * re-reads under the gate before committing. The target file is never removed
 * along the way, so a racer can never see the path as momentarily free.
 */
function replaceRecord(loc, record, pid, linkImpl, confirm) {
  try {
    mkdirSync(loc.dir, { recursive: true });
  } catch (err) {
    return { ok: false, error: `could not create ${loc.dir}: ${err?.message ?? String(err)}` };
  }
  const gate = `${loc.absolute}.claim`;
  const got = exclusiveCreate(gate, `${pid}\n`, linkImpl, pid);
  if (!got.ok) {
    if (got.taken) return { ok: false, busy: true, error: 'another terminal is changing this lease right now' };
    return { ok: false, error: got.error };
  }
  try {
    // ⭐ Re-read UNDER the gate. Between our first look and winning the gate,
    // another terminal may have completed the very takeover we are attempting.
    const verdict = confirm(readLeaseFile(loc.absolute));
    if (!verdict.ok) return verdict;

    const temp = `${loc.absolute}.tmp-${pid}`;
    try {
      writeFileSync(temp, serialize(record), 'utf8');
    } catch (err) {
      return { ok: false, error: `could not stage the lease: ${err?.message ?? String(err)}` };
    }
    const moved = renameWithRetry(temp, loc.absolute);
    if (!moved.ok) {
      try { unlinkSync(temp); } catch { /* nothing staged */ }
      return { ok: false, error: `could not publish the lease: ${moved.error}` };
    }
    return { ok: true };
  } finally {
    try { unlinkSync(gate); } catch { /* already gone */ }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// HANDLES AND REFUSALS
// ═══════════════════════════════════════════════════════════════════════════

function handleFor(root, loc, record) {
  return {
    root: resolve(root),
    path: record.path,
    key: record.key,
    file: loc.absolute,
    dir: loc.dir,
    holder: record.holder,
    pid: record.pid,
    token: record.token,
    ttlMs: record.ttlMs,
    acquiredAt: record.acquiredAt,
    renewedAt: record.renewedAt,
    takeovers: record.takeovers,
  };
}

/**
 * ⚠️ A REFUSAL IS THE PRODUCT HERE, so it has to be readable. Whoever hits this
 * is a person with seven terminals open wondering why one of them stopped, and
 * "lease held" tells them nothing. Name the holder, the pid, the age, and — if
 * it is expired but still protected — say exactly how long the wait is and why.
 */
function refusal(loc, held, now, holder, pid, warnings) {
  const silentForMs = now - held.renewedAt;
  const reclaimableInMs = Math.max(0, reclaimableAfter(held.ttlMs) - silentForMs);
  const expired = silentForMs > held.ttlMs;

  let error = `${loc.path} is leased by "${held.holder}" (pid ${held.pid}), taken at ${held.acquiredAt} and last heartbeat ${silentForMs}ms ago`;
  if (expired && reclaimableInMs > 0) {
    error += `; the lease expired ${silentForMs - held.ttlMs}ms ago but cannot be reclaimed for another ${reclaimableInMs}ms — taking it early would hand two live agents the same file`;
  }
  if (held.holder === holder && held.pid !== pid) {
    error += `; the holder name matches yours but the pid does not (${held.pid} vs ${pid}), so that is a second terminal, not you`;
  }
  if (held.path !== loc.path) {
    error += `; the lease is recorded as "${held.path}" and you asked for "${loc.path}" — they differ only in case, and on a case-insensitive filesystem that is ONE file`;
  }
  return {
    ok: false,
    heldBy: held.holder,
    heldByPid: held.pid,
    since: held.acquiredAt,
    path: loc.path,
    state: stateOf(silentForMs, held.ttlMs),
    expired,
    silentForMs,
    reclaimableInMs,
    error,
    warnings,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// THE PUBLIC SURFACE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Take a lease on one path.
 *
 * → `{ ok: true, lease, warnings, reacquired?, takeover? }`
 * → `{ ok: false, heldBy, since, expired, reclaimableInMs, error, warnings }`
 */
export function acquire(root, options = {}) {
  const opts = options ?? {};
  const { path: rawPath, holder: rawHolder, ttlMs, clock = wallClock, linkImpl = linkSync } = opts;
  const warnings = [];

  const time = checkClock(clock);
  if (!time.ok) return { ok: false, error: time.error, warnings };
  const now = time.now;

  const who = checkHolder(rawHolder);
  if (!who.ok) return { ok: false, error: who.error, warnings };
  const holder = who.holder;

  const loc = leaseFilePath(root, rawPath);
  if (!loc.ok) return { ok: false, error: loc.error, warnings };

  const pid = normalizePid(opts.pid);
  const ttl = clampTtl(ttlMs);
  const existing = readLeaseFile(loc.absolute);

  if (existing.state === 'unreadable') {
    return { ok: false, error: `the lease file for ${loc.path} could not be read (${existing.why}) — refusing rather than assuming it is free`, warnings };
  }

  // ── Somebody (possibly us) already has a readable record ──────────────────
  if (existing.state === 'held') {
    const held = existing.record;

    // ⭐ RE-ENTRANCY. A terminal that declares the same file twice — or retries
    // after a hiccup — must not deadlock against itself. Same holder AND same
    // pid is the same terminal, so this is a heartbeat that keeps the token.
    if (held.holder === holder && held.pid === pid) {
      const next = { ...held, path: held.path, ttlMs: ttl, renewedAt: now };
      const wrote = replaceRecord(loc, next, pid, linkImpl, (current) => (
        current.state === 'held' && current.record.token === held.token
          ? { ok: true }
          : { ok: false, error: `the lease on ${loc.path} changed hands while re-acquiring it`, warnings }
      ));
      if (!wrote.ok) return { ok: false, error: wrote.error, warnings };
      return { ok: true, reacquired: true, lease: handleFor(root, loc, next), warnings };
    }

    const silentForMs = now - held.renewedAt;
    if (silentForMs <= reclaimableAfter(held.ttlMs)) {
      return refusal(loc, held, now, holder, pid, warnings);
    }

    // ── The holder has been silent long past its TTL. Take it, and say so. ──
    const takeover = { from: held.holder, pid: held.pid, at: now, silentForMs, token: held.token };
    const record = {
      version: LEASE_VERSION,
      path: loc.path,
      key: loc.key,
      holder,
      pid,
      token: deriveToken({ path: loc.path, holder, pid, acquiredAt: now }),
      ttlMs: ttl,
      acquiredAt: now,
      renewedAt: now,
      takeovers: [...held.takeovers, takeover].slice(-MAX_TAKEOVERS),
    };
    const wrote = replaceRecord(loc, record, pid, linkImpl, (current) => {
      if (current.state !== 'held') return { ok: false, error: `the lease on ${loc.path} vanished mid-takeover`, warnings };
      if (current.record.token !== held.token) return refusal(loc, current.record, now, holder, pid, warnings);
      if (now - current.record.renewedAt <= reclaimableAfter(current.record.ttlMs)) return refusal(loc, current.record, now, holder, pid, warnings);
      return { ok: true };
    });
    if (!wrote.ok) {
      if (wrote.heldBy) return wrote;
      return { ok: false, heldBy: held.holder, since: held.acquiredAt, error: wrote.error, warnings };
    }
    warnings.push(`took over ${loc.path} from "${held.holder}" (pid ${held.pid}) after ${silentForMs}ms of silence`);
    return { ok: true, takeover, lease: handleFor(root, loc, record), warnings };
  }

  // ── Corrupt: treat as absent, loudly, and never as a lock ─────────────────
  const record = {
    version: LEASE_VERSION,
    path: loc.path,
    key: loc.key,
    holder,
    pid,
    token: deriveToken({ path: loc.path, holder, pid, acquiredAt: now }),
    ttlMs: ttl,
    acquiredAt: now,
    renewedAt: now,
    takeovers: [],
  };

  if (existing.state === 'corrupt') {
    warnings.push(`corrupt lease file for ${loc.path} (${existing.why}) — treating it as absent and taking the lease`);
    const wrote = replaceRecord(loc, record, pid, linkImpl, (current) => (
      // ⭐ Still corrupt under the gate? Then it really is debris. If it now
      // parses, a real holder appeared while we looked and it is theirs.
      current.state === 'held'
        ? refusal(loc, current.record, now, holder, pid, warnings)
        : { ok: true }
    ));
    if (!wrote.ok) {
      if (wrote.heldBy) return wrote;
      return { ok: false, error: wrote.error, warnings };
    }
    return { ok: true, lease: handleFor(root, loc, record), warnings };
  }

  // ── Free: an exclusive create is the whole race ───────────────────────────
  try {
    mkdirSync(loc.dir, { recursive: true });
  } catch (err) {
    return { ok: false, error: `could not create ${loc.dir}: ${err?.message ?? String(err)}`, warnings };
  }
  const made = exclusiveCreate(loc.absolute, serialize(record), linkImpl, pid);
  if (made.ok) return { ok: true, lease: handleFor(root, loc, record), warnings };
  if (!made.taken) return { ok: false, error: made.error, warnings };

  // We lost the create. Re-read so the refusal names whoever actually won.
  const winner = readLeaseFile(loc.absolute);
  if (winner.state === 'held') return refusal(loc, winner.record, now, holder, pid, warnings);
  return { ok: false, error: `lost a race for ${loc.path} to another terminal`, warnings };
}

/**
 * Heartbeat. → `{ ok: true, lease }` or `{ ok: false, reason, heldBy?, error }`
 * where reason is `gone` | `lost` | `expired` | `corrupt` | `busy` | `invalid`.
 *
 * ⚠️⚠️ THE FAILURES HERE ARE THE POINT. An agent that keeps writing under a
 * lease it no longer holds is the exact corruption this module exists to stop,
 * so a heartbeat that cannot prove ownership must fail loudly instead of
 * quietly re-creating the record.
 */
export function renew(lease, options = {}) {
  const { clock = wallClock, linkImpl = linkSync } = options ?? {};

  const time = checkClock(clock);
  if (!time.ok) return { ok: false, reason: 'invalid', error: time.error };
  const now = time.now;

  if (!lease || typeof lease !== 'object' || typeof lease.file !== 'string' || typeof lease.token !== 'string') {
    return { ok: false, reason: 'invalid', error: 'not a lease handle' };
  }

  const current = readLeaseFile(lease.file);
  if (current.state === 'absent') {
    return { ok: false, reason: 'gone', error: `the lease on ${lease.path} no longer exists — it was released or cleaned up` };
  }
  if (current.state === 'unreadable') {
    return { ok: false, reason: 'corrupt', error: `the lease file for ${lease.path} could not be read (${current.why})` };
  }
  if (current.state === 'corrupt') {
    return { ok: false, reason: 'corrupt', error: `the lease file for ${lease.path} is corrupt (${current.why}) — re-acquire rather than heartbeat` };
  }

  const held = current.record;
  if (held.token !== lease.token) {
    return {
      ok: false,
      reason: 'lost',
      heldBy: held.holder,
      heldByPid: held.pid,
      error: `${lease.path} is now leased by "${held.holder}" (pid ${held.pid}) — stop writing to it`,
    };
  }
  if (now - held.renewedAt > held.ttlMs) {
    // ⚠️ Past our own TTL a blind write races whoever is mid-takeover. The
    // honest recovery is one `acquire`, which re-checks under the gate.
    return { ok: false, reason: 'expired', error: `the lease on ${lease.path} lapsed ${now - held.renewedAt - held.ttlMs}ms ago — re-acquire it` };
  }

  const loc = { absolute: lease.file, dir: lease.dir, path: lease.path };
  const next = { ...held, renewedAt: now };
  const wrote = replaceRecord(loc, next, normalizePid(lease.pid), linkImpl, (under) => (
    under.state === 'held' && under.record.token === lease.token
      ? { ok: true }
      : { ok: false, reason: 'lost', heldBy: under.state === 'held' ? under.record.holder : null, error: `${lease.path} changed hands mid-heartbeat` }
  ));
  if (!wrote.ok) return { ok: false, reason: wrote.reason ?? (wrote.busy ? 'busy' : 'invalid'), heldBy: wrote.heldBy, error: wrote.error };

  return { ok: true, lease: { ...lease, renewedAt: now, ttlMs: held.ttlMs } };
}

/**
 * Give a lease back. **Always safe** — expired, already released, taken over,
 * a nonsense handle, or a workspace that has been deleted underneath us.
 *
 * ⚠️ NEVER DELETES SOMEBODY ELSE'S LEASE. A terminal that stalled long enough
 * to be taken over would otherwise unlock the file under its new owner on the
 * way out, which is the same corruption arriving by the back door.
 */
export function release(lease) {
  if (!lease || typeof lease !== 'object' || typeof lease.file !== 'string' || typeof lease.token !== 'string') {
    return { ok: true, released: false, reason: 'not a lease handle' };
  }
  const current = readLeaseFile(lease.file);
  if (current.state === 'absent') return { ok: true, released: false, reason: 'already released' };
  if (current.state === 'unreadable') return { ok: true, released: false, reason: `unreadable (${current.why})` };
  if (current.state === 'corrupt') {
    try { unlinkSync(lease.file); } catch { /* somebody else got there */ }
    return { ok: true, released: true, reason: 'the record was corrupt and has been cleared' };
  }
  if (current.record.token !== lease.token) {
    return { ok: true, released: false, reason: `${lease.path} is now leased by "${current.record.holder}" (pid ${current.record.pid}) — leaving it alone` };
  }
  try {
    unlinkSync(lease.file);
  } catch (err) {
    if (err?.code !== 'ENOENT') return { ok: true, released: false, reason: err?.message ?? String(err) };
    return { ok: true, released: false, reason: 'already released' };
  }
  return { ok: true, released: true };
}

// ═══════════════════════════════════════════════════════════════════════════
// MANY PATHS AT ONCE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Take every path or none of them.
 *
 * ⚠️ TWO INVARIANTS AND BOTH ARE ABOUT DEADLOCK. **All-or-nothing**, because a
 * terminal holding three of five files and waiting on the fourth is a stall
 * nobody can diagnose. And a **fixed global order** (case-folded, sorted), so
 * two terminals wanting the same two files always contend in the same
 * direction — lock-ordering deadlock stops being possible rather than becoming
 * unlikely. Everything is validated before a single byte is written.
 */
export function acquireAll(root, options = {}) {
  const opts = options ?? {};
  const { paths = [], holder, ttlMs, clock = wallClock, linkImpl = linkSync } = opts;
  const warnings = [];

  if (!Array.isArray(paths)) return { ok: false, error: 'paths must be an array', leases: [], warnings };

  const located = [];
  for (const raw of paths) {
    const loc = leaseFilePath(root, raw);
    if (!loc.ok) return { ok: false, error: loc.error, path: raw, leases: [], warnings };
    located.push(loc);
  }

  const ordered = [...new Map(located.map((l) => [l.key, l])).values()]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const taken = [];
  for (const loc of ordered) {
    const got = acquire(root, { path: loc.path, holder, pid: opts.pid, ttlMs, clock, linkImpl });
    if (!got.ok) {
      releaseAll(taken);
      return {
        ok: false,
        error: got.error,
        heldBy: got.heldBy ?? null,
        since: got.since ?? null,
        path: loc.path,
        leases: [],
        warnings: [...warnings, ...(got.warnings ?? [])],
      };
    }
    warnings.push(...got.warnings);
    taken.push(got.lease);
  }
  return { ok: true, leases: taken, warnings };
}

/**
 * Heartbeat a set.
 *
 * ⚠️ REPORTS WHAT IT LOST rather than collapsing to one boolean. "Four of five
 * renewed and here is the one that did not, and who has it now" is actionable;
 * `false` is not.
 */
export function renewAll(leases = [], options = {}) {
  const renewed = [];
  const lost = [];
  for (const lease of Array.isArray(leases) ? leases : []) {
    const beat = renew(lease, options);
    if (beat.ok) renewed.push(beat.lease);
    else lost.push({ path: lease?.path ?? null, reason: beat.reason, heldBy: beat.heldBy ?? null, error: beat.error });
  }
  return { ok: lost.length === 0, renewed: renewed.length, leases: renewed, lost };
}

/** Give a set back. Never throws, whatever is in the array. */
export function releaseAll(leases = []) {
  const results = [];
  let released = 0;
  for (const lease of Array.isArray(leases) ? leases : []) {
    const one = release(lease);
    if (one.released) released += 1;
    results.push({ path: lease?.path ?? null, ...one });
  }
  return { ok: true, released, results };
}

// ═══════════════════════════════════════════════════════════════════════════
// INSPECT — who holds what, and is it stale
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Read every lease in a workspace. **Never throws and never fails on debris** —
 * this is the call a stuck human makes to find out why their terminal stopped,
 * so it has to work on exactly the broken workspace they are staring at.
 */
export function inspect(root, options = {}) {
  const { clock = wallClock } = options ?? {};
  const time = checkClock(clock);
  if (!time.ok) return { ok: false, error: time.error, leases: [], warnings: [], corrupt: 0 };
  const now = time.now;

  if (typeof root !== 'string' || !root.trim()) {
    return { ok: false, error: 'a workspace root is required', leases: [], warnings: [], corrupt: 0 };
  }
  const dir = join(resolve(root), ...LEASE_DIR.split('/'));

  let names;
  try {
    names = readdirSync(dir);
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return { ok: true, dir, leases: [], warnings: [], corrupt: 0 };
    return { ok: false, error: `could not read ${dir}: ${err?.message ?? String(err)}`, leases: [], warnings: [], corrupt: 0 };
  }

  const leases = [];
  const warnings = [];
  let corrupt = 0;

  for (const name of names.sort()) {
    // ⚠️ Only records. A `.claim` gate or a `.tmp-` staging file is another
    // terminal mid-write, not debris, and reporting it would be noise.
    if (!name.endsWith('.json')) continue;
    const found = readLeaseFile(join(dir, name));
    if (found.state === 'held') {
      const rec = found.record;
      const silentForMs = now - rec.renewedAt;
      leases.push({
        path: rec.path,
        holder: rec.holder,
        pid: rec.pid,
        token: rec.token,
        state: stateOf(silentForMs, rec.ttlMs),
        ttlMs: rec.ttlMs,
        acquiredAt: rec.acquiredAt,
        renewedAt: rec.renewedAt,
        ageMs: now - rec.acquiredAt,
        silentForMs,
        reclaimableInMs: Math.max(0, reclaimableAfter(rec.ttlMs) - silentForMs),
        takeovers: rec.takeovers,
        file: join(dir, name),
      });
    } else if (found.state === 'corrupt' || found.state === 'unreadable') {
      corrupt += 1;
      warnings.push(`corrupt lease file ${name} (${found.why}) — it holds nothing and can be deleted`);
    }
  }

  leases.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { ok: true, dir, leases, warnings, corrupt };
}

/** Render `inspect()` for a terminal. Returns lines; never throws. */
export function formatLeaseSummary(view) {
  if (!view || typeof view !== 'object') return ['no lease information available'];
  if (view.ok === false) return [`could not read leases: ${view.error ?? 'unknown error'}`];

  const leases = Array.isArray(view.leases) ? view.leases : [];
  const lines = [];
  if (leases.length === 0) {
    lines.push('no file leases are held in this workspace');
  } else {
    lines.push(`${leases.length} file lease${leases.length === 1 ? '' : 's'}:`);
    for (const l of leases) {
      const mark = l.state === 'live' ? '·' : l.state === 'expired' ? '!' : 'x';
      let line = `  ${mark} ${l.path} — ${l.holder} (pid ${l.pid}) ${l.state}, silent ${Math.round(l.silentForMs / 1000)}s`;
      if (l.state === 'expired') line += `, reclaimable in ${Math.round(l.reclaimableInMs / 1000)}s`;
      if (Array.isArray(l.takeovers) && l.takeovers.length) {
        const last = l.takeovers[l.takeovers.length - 1];
        line += ` — took over from ${last.from} (pid ${last.pid})`;
      }
      lines.push(line);
    }
  }
  for (const w of Array.isArray(view.warnings) ? view.warnings : []) lines.push(`  ! ${w}`);
  return lines;
}

/**
 * ⭐ THE WIRING, WRITTEN DOWN. This package's repeated failure is a finished
 * module that nothing imports, so the exact lines live next to the code.
 */
export const REGISTRATION_SNIPPET = `
// ── WIRING lib/lease.mjs INTO bin/acuvo.mjs ────────────────────────────────
// The names below already exist in that file: 'root' (line ~281, the resolved
// workspace), 'opts' (parsed argv), EXIT_OK / EXIT_FAILED (lines 66-67).

// 1. one import, beside the parallel.mjs import at the top (line ~34)
import { acquireAll, renewAll, releaseAll, inspect, formatLeaseSummary } from '../lib/lease.mjs';

// 2. a read-only command, before any model work happens.
//    lib/cli-args.mjs must accept 'leases' as a command.
if (opts.command === 'leases') {
  process.stdout.write(formatLeaseSummary(inspect(root)).join('\\n') + '\\n');
  return EXIT_OK;
}

// 3. take the files this run intends to write, BEFORE the session starts.
//    'opts.lease' is a new repeatable flag: --lease src/a.ts --lease src/b.ts
const held = acquireAll(root, {
  paths: opts.lease ?? [],
  holder: opts.holder ?? String(process.pid),
  ttlMs: 120000,
});
if (!held.ok) {
  process.stderr.write(held.error + '\\n');
  return EXIT_FAILED;
}
held.warnings.forEach((w) => process.stderr.write('  ! ' + w + '\\n'));
process.on('exit', () => releaseAll(held.leases));

// 4. heartbeat between rounds — call this from the runSession onEvent hook.
//    STOP on a lost lease: continuing means writing over another terminal.
const beat = renewAll(held.leases);
if (!beat.ok) {
  process.stderr.write('lost a lease mid-run: ' + JSON.stringify(beat.lost) + '\\n');
  return EXIT_FAILED;
}

// ⚠️ THE HONEST LIMIT OF STEP 3: a coding agent does not know which files it
// will write until it writes them, so an up-front --lease list is a
// DECLARATION, not a guarantee. The complete fix is to call acquire() inside
// the executor's write path (lib/workspace.mjs) so every mutation is covered
// automatically. That is one more call, in one more lane, and this module is
// ready for it:
//   const got = acquire(root, { path: relPath, holder, ttlMs: 120000 });
//   if (!got.ok) return { ok: false, error: got.error };
`.trim();
