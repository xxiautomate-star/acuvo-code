/**
 * ── ⭐⭐ WHAT DID THIS COST ME — THE QUESTION WE ALREADY ANSWERED AND NEVER READ
 *
 * Every run appends one redacted JSON line to `.acuvo/audit/<date>.jsonl`,
 * including `costUsd`. `parseAuditLog` was written, exported and tested, and had
 * **zero runtime callers**. So the tool wrote the answer down every single time
 * and nobody could ask for it.
 *
 * That is the payer's first question — "what have I spent" — and for a product
 * whose whole pitch is that it tells you the price before it runs and stops at
 * the number you gave it, being unable to answer it afterwards is not a missing
 * report. It is the pitch with its last sentence removed.
 *
 * ── ⚠️⚠️ THE ONE RULE THIS FILE EXISTS TO ENFORCE ───────────────────────────
 *
 * `costUsd` IS NULL ON A REAL RECORD. A run that died on a 401 never billed
 * anything and honestly does not know what it cost; a run whose provider omitted
 * usage is the same. Summing null as zero would produce a total that is
 * confidently too low, in the one report a user checks precisely because they do
 * not trust their own memory of it.
 *
 * ⭐ So unknown is COUNTED AND REPORTED SEPARATELY, never folded in. A total of
 * "$0.0412 across 31 runs, 4 of which do not know what they cost" is useful and
 * true. "$0.0412 across 35 runs" is neither.
 *
 * ⚠️ AND THE WINDOW IS BOUNDED BY PRUNING, NOT BY THE QUESTION. `audit.mjs`
 * keeps at most MAX_AUDIT_FILES days and deletes whole files, so "all time" means
 * "as far back as the log still goes". The report says which day it can actually
 * see from, because a total that silently starts mid-history is the same lie as
 * one that counts null as zero.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AUDIT_DIR, parseAuditLog } from './audit.mjs';

/** `7d`, `24h`, `30`, or an ISO date. Returns a Date, or null for "everything". */
export function parseSince(raw, now = new Date()) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s || s === 'all') return null;

  const rel = /^(\d+)\s*([dhw])?$/.exec(s);
  if (rel) {
    const n = Number(rel[1]);
    if (!Number.isFinite(n) || n <= 0) return { error: `"${raw}" is not a period — try 7d, 24h, or a date like 2026-08-01` };
    const ms = { d: 86_400_000, h: 3_600_000, w: 604_800_000 }[rel[2] ?? 'd'];
    return new Date(now.getTime() - n * ms);
  }

  const at = new Date(s);
  if (Number.isNaN(at.getTime())) {
    return { error: `"${raw}" is not a period — try 7d, 24h, or a date like 2026-08-01` };
  }
  return at;
}

/**
 * Aggregate every audit record in a workspace.
 *
 * ⚠️ Pure over injected text, so the whole report is testable without touching a
 * filesystem — the same seam that makes the governor testable without spending.
 *
 * @param {Array<{name: string, text: string}>} files
 * @param {{ since?: Date|null }} [options]
 */
export function summariseSpend(files, { since = null } = {}) {
  let totalUsd = 0;
  let counted = 0;
  let unknown = 0;
  let damaged = 0;
  let failed = 0;
  const byDay = new Map();
  const byModel = new Map();
  let earliest = null;
  let latest = null;

  for (const file of files ?? []) {
    const parsed = parseAuditLog(file?.text ?? '');
    damaged += parsed.damaged;

    for (const rec of parsed.records) {
      const at = rec?.at ? new Date(rec.at) : null;
      if (at && Number.isNaN(at.getTime())) continue;
      if (since && at && at < since) continue;

      if (at) {
        if (!earliest || at < earliest) earliest = at;
        if (!latest || at > latest) latest = at;
      }

      const run = rec?.run ?? {};
      if (run.ok === false) failed += 1;

      const day = String(rec?.at ?? '').slice(0, 10) || 'unknown';
      const bucket = byDay.get(day) ?? { usd: 0, runs: 0, unknown: 0 };
      bucket.runs += 1;

      /**
       * ⚠️ `typeof === 'number'` — NOT a truthiness check. A genuine $0.00 run
       * (cached, or refused before any call) is a KNOWN zero and belongs in the
       * counted set; `if (run.costUsd)` would quietly reclassify it as unknown
       * and make the "we don't know" number look worse than it is.
       */
      if (typeof run.costUsd === 'number' && Number.isFinite(run.costUsd)) {
        totalUsd += run.costUsd;
        counted += 1;
        bucket.usd += run.costUsd;

        const model = run?.model?.answered ?? run?.model?.requested ?? 'unknown';
        const m = byModel.get(model) ?? { usd: 0, runs: 0 };
        m.usd += run.costUsd;
        m.runs += 1;
        byModel.set(model, m);
      } else {
        unknown += 1;
        bucket.unknown += 1;
      }

      byDay.set(day, bucket);
    }
  }

  return {
    ok: true,
    totalUsd,
    runs: counted + unknown,
    counted,
    /** ⚠️ Runs whose cost is genuinely unknown. NEVER added to totalUsd as zero. */
    unknown,
    failed,
    damaged,
    earliest: earliest ? earliest.toISOString() : null,
    latest: latest ? latest.toISOString() : null,
    byDay: [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, v]) => ({ day, ...v })),
    byModel: [...byModel.entries()].sort((a, b) => b[1].usd - a[1].usd).map(([model, v]) => ({ model, ...v })),
  };
}

/** Read the audit directory. Returns `[]` when there is none — that is not an error. */
export function readAuditFiles(root, { dir = AUDIT_DIR } = {}) {
  const target = join(root, dir);
  let names;
  try {
    names = readdirSync(target).filter((n) => n.endsWith('.jsonl')).sort();
  } catch {
    return [];
  }
  const files = [];
  for (const name of names) {
    try {
      files.push({ name, text: readFileSync(join(target, name), 'utf8') });
    } catch { /* a file that vanished mid-read is not worth failing the report for */ }
  }
  return files;
}

const money = (n) => (n < 0.01 ? `${(n * 100).toFixed(3)}c` : `$${n.toFixed(4)}`);

/** The human report. Lines without the leading indent, like every other view. */
export function formatSpend(summary, { since = null } = {}) {
  if (!summary || summary.runs === 0) {
    return [
      'No runs recorded here yet.',
      'Every run appends one line to .acuvo/audit/<date>.jsonl — unless it was given --no-audit.',
    ];
  }

  const lines = [];
  const window = since ? `since ${since.toISOString().slice(0, 10)}` : 'all recorded runs';

  /**
   * ⚠️ WHEN NOTHING IS KNOWN, DO NOT LEAD WITH A TOTAL. "0.000c across 0 runs"
   * next to "1 run did not record a cost" is accurate and reads as "nothing
   * happened" — which is the impression this whole report exists to prevent.
   * Say what is actually true: runs occurred and none of them recorded a price.
   */
  if (summary.counted === 0 && summary.unknown > 0) {
    lines.push(`${summary.unknown} run${summary.unknown === 1 ? '' : 's'} recorded, none of which reported a cost · ${window}`);
  } else {
    lines.push(`${money(summary.totalUsd)} across ${summary.counted} run${summary.counted === 1 ? '' : 's'} · ${window}`);
  }

  /**
   * ⚠️ THE UNKNOWNS GET THEIR OWN LINE, ALWAYS, when there are any. Burying them
   * in a footnote is how a total that is too low gets believed.
   */
  if (summary.unknown > 0) {
    lines.push(`⚠️ ${summary.unknown} run${summary.unknown === 1 ? '' : 's'} did not record a cost — not counted above, and not zero.`);
  }
  if (summary.failed > 0) lines.push(`${summary.failed} of those runs failed.`);
  if (summary.damaged > 0) lines.push(`⚠️ ${summary.damaged} damaged log line${summary.damaged === 1 ? '' : 's'} skipped.`);

  if (summary.earliest) {
    lines.push(`Log reaches back to ${summary.earliest.slice(0, 10)} — older days are pruned, so this is not necessarily your whole history.`);
  }

  if (summary.byDay.length > 1) {
    lines.push('');
    for (const d of summary.byDay.slice(-14)) {
      const flag = d.unknown > 0 ? `  (${d.unknown} unknown)` : '';
      lines.push(`  ${d.day}  ${money(d.usd).padStart(9)}  ${String(d.runs).padStart(3)} run${d.runs === 1 ? ' ' : 's'}${flag}`);
    }
  }

  if (summary.byModel.length > 0) {
    lines.push('');
    for (const m of summary.byModel.slice(0, 5)) {
      lines.push(`  ${money(m.usd).padStart(9)}  ${m.model}`);
    }
  }

  return lines;
}
