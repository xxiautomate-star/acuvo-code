---
name: background-jobs
description: Durable background work for a generated app — AcuvoJobs.enqueue runs a server function later with retries and keeps the result; AcuvoJobs.wait returns when it is done — for imports, reports, sends and multi-step work that must not be lost.
when: The brief has work that is slow, must not be lost, or has several steps — importing a file, generating a report, sending in bulk, anything a visitor should not sit on a spinner for.
---

# Background jobs

A job is "run `functions/<fn>.js` later, with these args, and do not lose it".
It is claimed atomically, retried with backoff (1 min, 5 min, 15 min) up to
three attempts, and keeps its result or its last error.

```js
// the page: hand the work over, then wait or come back later
const { id } = await AcuvoJobs.enqueue('build-report', { month: '2026-09' });
const job = await AcuvoJobs.wait(id, { every: 2000, timeout: 120000 });
if (job.status === 'done') render(job.result); else show(job.error);

// later, from anywhere: AcuvoJobs.get(id) → { id, status, result, error, attempts }
```

```js
// functions/build-report.js — the job's function; `job` rides in with the args
module.exports = async function (args, ctx) {
  const { records } = await ctx.data.list('sales', { limit: 500 });
  const rows = records.filter((r) => String(r.value.date || '').startsWith(args.month));
  const total = rows.reduce((s, r) => s + Number(r.value.amount || 0), 0);
  await ctx.data.put('reports', args.month, { total, count: rows.length, at: new Date().toISOString() });
  return { total, count: rows.length, attempt: args.job.attempt };
};
```

When the request has budget the job runs at once and `enqueue` already returns
it finished (`ran: 'inline'`); otherwise it runs within the minute. Either way
the page code is the same: enqueue, then wait or poll.

## Chaining: work longer than one function

A function's budget is 10 seconds (30 with the model). Split long work into
slices and let each slice enqueue the next:

```js
// functions/import-rows.js — 200 rows per slice, then the next slice
module.exports = async function (args, ctx) {
  const { text } = await ctx.files.readText(args.fileId);
  const lines = text.split('\n').slice(1);
  const from = Number(args.from || 0), to = Math.min(lines.length, from + 200);
  for (let i = from; i < to; i++) { const [name, email] = lines[i].split(','); if (email) await ctx.data.put('contacts', email.trim(), { name: name.trim() }); }
  if (to < lines.length) await ctx.jobs.enqueue('import-rows', { fileId: args.fileId, from: to });
  return { imported: to, of: lines.length };
};
```

`ctx.jobs.enqueue(fn, args, { delaySeconds })` is the same door from inside a
function. Use `delaySeconds` for "in an hour" or "tomorrow morning" work.

## Rules

- **Make the function idempotent.** A retry runs it again from the start with
  the same args. Writing `contacts/<email>` twice is harmless; sending an email
  twice is not. Check the store before a side effect.
- **Keep args small and plain.** Under 16 KB, JSON only. Put a big input in
  `AcuvoFiles` and pass the id.
- **Return something.** The return value is the job's `result` (under 16 KB):
  counts, ids, a summary. The page shows it; the owner sees it in the workspace.
- **Throw on real failure, return on partial.** A throw is retried; a returned
  `{ skipped: 12 }` is done. Choose which one the situation is.
- **Tell the visitor the truth.** "Working on it, this can take a minute" beats
  a spinner. `wait` rejects with `code: 'timeout'` while a job still runs;
  keep the id and let them check back.

## What it is not

Not a cron: a schedule (`AcuvoSchedule`) runs a function on the clock; a job
runs once, soon, with retries. Not realtime: `AcuvoData.watch` is for that.
Not a way past the caps: each attempt is a normal function run.
