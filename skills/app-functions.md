---
name: app-functions
description: Server-side logic for a generated app — work the browser must not do: totals across every visitor, a call that needs a secret key, validation the page cannot be trusted with. Write functions/<name>.js and call it with AcuvoFunctions.call.
when: The app needs something computed on the server rather than in the page — a shared total, a secret key, server-side validation, or a scheduled job
---

# Server functions — the other half of an app

A page can only trust itself. A leaderboard across every player, a coupon check
the visitor must not be able to edit, a call to a paid API with the owner's key:
those run on the server. In this builder that is one file per function.

## The shape

```js
// functions/leaderboard.js
module.exports = async function (args, ctx) {
  const { records } = await ctx.data.list('scores', { limit: 200 });
  const top = records
    .map((r) => ({ name: r.key, points: Number(r.value.points) || 0 }))
    .sort((a, b) => b.points - a.points)
    .slice(0, args.limit || 10);
  ctx.log('ranked', top.length);
  return top;
};
```

From the page:

```js
const top = await AcuvoFunctions.call('leaderboard', { limit: 10 });
```

`args` is whatever the page passed (JSON, under 16 KB). The return value comes
back to the page (JSON, under 64 KB). A thrown error reaches the page as an
`Error` whose `message` is yours — say something a person can act on.

## The same function in Python

Name the file `functions/<name>.py` and define `main(args, ctx)`; it runs where the
JavaScript one runs, with the same `ctx`, caps and callers (page, webhook, schedule,
trigger, job). Standard library only; no `pip`. Snake and camel both work on `ctx`
(`ctx.files.read_text` / `ctx.files.readText`). Pick Python when the work is
numbers, text or data shaping; pick JavaScript when it shares code with the page.

```python
# functions/stats.py — a rollup the page asks for
def main(args, ctx):
    out = ctx.data.list('orders', {'limit': 500})
    paid = [r['value'] for r in out['records'] if r['value'].get('paid')]
    total = sum(float(v.get('amount') or 0) for v in paid)
    ctx.log('paid', len(paid))
    return {'count': len(paid), 'total': total}
```

`ctx.ai.chat(messages, system=...)` accepts a string or a list; tools are a dict of
`{'name': {'description', 'parameters', 'run': callable}}`. Raise to fail (a job
retries); return to finish.

## What `ctx` gives you — and nothing else

- `ctx.data.list(collection, { limit, offset })` → `{ records, total }` —
  the SHARED store, the same records the page reads with `AcuvoData`.
- `ctx.data.get(collection, key)` → the record or `null`.
- `ctx.data.put(collection, key, value)` · `ctx.data.delete(collection, key)`.
- `ctx.proxy.fetch(secretName, url, { method, headers, body })` → `{ status, body }`
  through the owner's stored key — the same rules as `AcuvoProxy.fetch`.
- `ctx.sql(text, params)` → `{ rows, rowCount }` on the app's OWN Postgres schema
  (tables from `migrations/NNNN_name.sql`, applied before the function runs; see `app-sql`).
- `ctx.ai.chat(messages, { system })` → `{ reply }` — the platform's own model, no
  key, metered per app. `messages` is `[{ role: 'user'|'assistant', content }]`
  (at most 12, up to 8,000 characters each) or one string. This is how a function THINKS: classify a record,
  draft a reply, summarise the week. Give it TOOLS and it can ACT mid-thought:

  ```js
  const { reply, toolRuns } = await ctx.ai.chat(args.question, {
    system: 'You answer questions about orders. Look the order up before answering.',
    tools: {
      lookup_order: { description: 'Fetch one order by id', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        run: async ({ id }) => (await ctx.data.get('orders', id)) || { error: 'no such order' } },
    },
  });
  ```

  Each tool is `{ description, parameters (JSON schema), run(args) }`; `run` is your
  own closure, so it can read the store, call a connector or write a record. The
  model may call tools up to four rounds; `toolRuns` lists what it did.
- `ctx.agent.chat(name, text, conversationId)` → `{ reply, conversationId, toolRuns }` — one turn
  with an agent the app defines in `agents/<name>.js` (see `build-an-agent`); a webhook
  becomes a Telegram bot in three lines.
- `ctx.live.send(channel, payload)` → `{ id }` — a message to every page listening on that
  channel right now (see `realtime`): "your export is ready".
- `ctx.jobs.enqueue(fn, args, { delaySeconds })` → `{ id }` — run another function later,
  with retries; how work longer than one budget is chained (see `background-jobs`).
- `ctx.web.search(q, { limit })` → `{ results: [{ title, url, snippet }] }` and
  `ctx.web.read(url)` → `{ title, text }` — today's internet, keyless (see `live-web`).
- `ctx.email.send({ subject, text, html })` → the app's OWNER's inbox, nobody else (see `app-email`).
- `ctx.files.list()` · `ctx.files.readText(id)` · `ctx.files.remove(id)` — what visitors uploaded (see `app-files`).
- `ctx.log(...)` — lines returned with the result, for debugging.

There is no `require`, no file system, no `fetch`, no `process`. A function
may make at most 25 store/proxy calls and must finish within 10 seconds.
Per-visitor PRIVATE records (`scope: 'private'`) are not reachable from a
function — it runs as the app, not as a person.

## Rules

- Keep functions small and pure; do the heavy lifting in the store query.
- **Never import a `functions/` file from the page.** It is server code and the
  address `/functions/…` is not served — the import would 404.
- Validate `args` yourself; the page can send anything.
- Prefer one function per verb (`checkout`, `leaderboard`, `verify-coupon`)
  over one function that switches on `args.action`.

## Shared code

Put helpers in `lib/` (or `shared/`) and `require` them from any function or agent:
`const money = require('../lib/money.js')`, `require('./sibling')`, `require('/lib/rates.json')`.
Relative to the file, `.js`/`.cjs`/`.json`, `index.js` in a folder, `module.exports` or
`export`. Nothing else can be required — no npm packages, no node modules; if a helper
needs `ctx`, export a function that takes it: `module.exports = (ctx) => ({ … })`.

## A clock in the file: `// every: 1d`

Put `// every: 1d` (or `15m`, `2h`; in Python `# every: 1d`) on one of the first five lines
of a function file and the schedule exists the moment the build is saved — no
`AcuvoSchedule.set` on the page, nothing for the owner to do. Remove the line and the
schedule goes; the owner's own schedules in the panel are never touched. Ticks call the
function with `{ schedule: { name, runs, at }, rows }`.

## An agent is a function on the clock

Everything an autonomous agent needs is already in `ctx`. A schedule calls the
function with `{ schedule, rows }`; the function reads, thinks, acts, and tells
the owner. No key, no server, no framework:

```js
// functions/triage.js — every 15 minutes: read new enquiries, classify, reply on Telegram, email the owner
module.exports = async function (args, ctx) {
  const { records } = await ctx.data.list('enquiries', { limit: 50 });
  const fresh = records.filter((r) => !r.value.triaged);
  for (const r of fresh) {
    const { reply } = await ctx.ai.chat(`Classify this enquiry as hot, warm or cold and draft a two-line reply:\n${r.value.message}`,
      { system: 'You triage enquiries for a plumbing business in Sydney. Answer as JSON {"heat":"hot|warm|cold","reply":"..."}.' });
    let verdict = { heat: 'warm', reply: '' }; try { verdict = JSON.parse(reply); } catch {}
    await ctx.data.put('enquiries', r.key, { ...r.value, triaged: true, heat: verdict.heat, draft: verdict.reply });
    if (verdict.heat === 'hot') await ctx.proxy.fetch('telegram', 'https://api.telegram.org/bot{{secret}}/sendMessage', { method: 'POST', body: { chat_id: args.chatId || '', text: `HOT: ${r.value.name} — ${verdict.reply}` } });
  }
  if (fresh.length) await ctx.email.send({ subject: `${fresh.length} enquiries triaged`, text: fresh.map((r) => `${r.value.name}: ${r.value.heat}`).join('\n') });
  return { triaged: fresh.length };
};
```

Set it running with `AcuvoSchedule.set('triage', { every: '15m', fn: 'triage' })` from the
page once, and give it inbound eyes with a webhook (below). Chain schedules for
work longer than ten seconds: each tick takes the next slice from the store.

## A function that runs after every change

Name a file `functions/on-<collection>.js` and it runs, as a background job with
retries, after every `AcuvoData.set` or `remove` on that collection. The file's
name is the subscription; nothing to register:

```js
// functions/on-orders.js — an order landed: tell the owner, keep a running total
module.exports = async function (args, ctx) {
  // args: { event: 'set' | 'remove', collection: 'orders', key, value, owner, job }
  if (args.event !== 'set' || !args.value || !args.value.paid) return { skipped: true };
  const totals = (await ctx.data.get('totals', 'today')) || { count: 0, amount: 0 };
  await ctx.data.put('totals', 'today', { count: totals.count + 1, amount: totals.amount + Number(args.value.amount || 0) });
  await ctx.email.send({ subject: `Order ${args.key} paid`, text: `${args.value.amount} from ${args.value.email || 'a customer'}` });
  return { counted: true };
};
```

It is a job: idempotent by habit (a retry brings the same event again), small
and quick, a return for "handled" and a throw for "try again". A big record
arrives as `{ truncated: true }`; read it with `ctx.data.get`. Writes made by
the function itself to the same collection fire it again — guard against loops
with a field you set (`processed: true`). A trigger added by a build is live
within a minute.

## Inbound webhooks — the same function, called from outside

Every `functions/<name>.js` also has a webhook address. An outside service
(Stripe, Zapier, a form provider, GitHub) POSTs to it and the SAME handler
runs with the request as `args`:

```js
// functions/stripe-events.js
module.exports = async function (args, ctx) {
  if (!args.hook) throw new Error('this function only accepts webhook deliveries');
  // args = { hook: { name, method, receivedAt, signed }, headers, query, body }
  if (!args.hook.signed) throw new Error('unsigned delivery refused');
  const event = args.body;                       // parsed JSON when the sender sent JSON
  if (event.type === 'checkout.session.completed') {
    await ctx.data.put('orders', event.data.object.id, { paid: true, amount: event.data.object.amount_total });
  }
  return { received: true };                     // becomes the HTTP response body
};
```

- The owner copies the address from the **Webhooks** panel and pastes it into
  the sender. The address carries the app's token; treat it like a password.
- To verify signatures, the owner stores the sender's secret in **API keys**
  as `webhook:<name>`. The door then checks `x-acuvo-signature` /
  `x-hub-signature-256` (`sha256=<hex>` over the raw body) or Stripe's
  `stripe-signature` before the function runs, and `args.hook.signed` is
  `true`. Never put the secret in code.
- A delivery body is at most 64 KB. The function's return value is the
  response; a throw answers 500 and is shown to the owner in the panel.
