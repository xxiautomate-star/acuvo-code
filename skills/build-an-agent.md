---
name: build-an-agent
description: An agent inside a generated app is ONE file, agents/<name>.js — persona, memory, tools that reach the app's own records and services — and the platform runs the loop, keeps the conversation and answers on the page, from a webhook, on a schedule.
when: The brief wants an assistant that answers from the app's own data or acts on it — support, booking, concierge, triage, a bot on Telegram or in the page — or "an agent for my business".
---

# Build an agent

Write one file. The platform runs it.

```js
// agents/support.js
module.exports = {
  system: 'You are the support agent for Harbour Plumbing in Sydney. Look an order up before answering about it. Be brief and plain.',
  memory: 12,            // turns remembered per conversation (0 = none)
  tools: {
    lookup_order: {
      description: 'Fetch one order by its id',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      run: async ({ id }, ctx) => (await ctx.data.get('orders', String(id))) || { error: 'no such order' },
    },
    book_callout: {
      description: 'Book a callout for a customer',
      parameters: { type: 'object', properties: { name: { type: 'string' }, suburb: { type: 'string' }, problem: { type: 'string' } }, required: ['name', 'problem'] },
      run: async (a, ctx) => { const key = 'b-' + Date.now(); await ctx.data.put('bookings', key, { ...a, status: 'new' }); await ctx.email.send({ subject: 'New booking', text: a.name + ' — ' + a.problem }); return { booked: key }; },
    },
  },
};
```

What you get for free:

- **The loop.** The model sees the tools, calls them (up to four rounds), reads
  the results, answers. A tool's `run(args, ctx)` has the SAME `ctx` a server
  function has: records, SQL, connectors, the live web, email, jobs, realtime.
- **The memory.** The last `memory` turns per conversation, kept in the app's
  store under an unguessable conversation id the caller holds. The page keeps
  the id per tab automatically.
- **The channels.** All of these reach the same agent:

```js
// the page
const { reply } = await AcuvoAgent.chat('support', input.value);   // remembers across turns
AcuvoAgent.reset('support');                                        // start over

// a server function, a webhook, a job — e.g. functions/telegram.js behind a Telegram webhook
module.exports = async function (args, ctx) {
  const msg = args.body && args.body.message; if (!msg) return { ignored: true };
  const { reply } = await ctx.agent.chat('support', msg.text, 'tg-' + msg.chat.id);   // one conversation per chat
  await ctx.proxy.fetch('telegram', 'https://api.telegram.org/bot{{secret}}/sendMessage', { method: 'POST', body: { chat_id: msg.chat.id, text: reply } });
  return { replied: true };
};
```

Optional hooks: `before(args, ctx)` returns extra system text for this turn
(today's date, the signed-in person's name, the stock list); `after({ reply,
toolRuns, args }, ctx)` may rewrite the reply or log it.

```js
// the proof build read `items` here and got nothing: the list answers { records, total }
before: async (args, ctx) => {
  const { records } = await ctx.data.list('orders', { limit: 6 });
  return records.length ? 'Known order ids: ' + records.map((r) => r.key).join(', ') : '';
},
```

## Channels and the clock, declared

The agent file can say where it listens and when it wakes, and saving the build
wires it — no function, nothing on the page:

```js
module.exports = {
  system: '…', tools: { … },
  schedule: { every: '1h', message: 'Summarise the last hour of enquiries and email me anything urgent.' },
  channels: {
    webhook: {                                   // POST /api/app-hooks/<token>/support
      text: 'body.message.text',                 // where the visitor's words are in the request
      conversation: 'body.message.chat.id',      // a stable key → one conversation per chat
      reply: { connector: 'telegram', url: 'https://api.telegram.org/bot{{secret}}/sendMessage',
               body: { chat_id: '$conversation', text: '$reply' } },
    },
  },
};
```

`schedule` becomes a schedule row (the agent is asked `message` every tick, on one
conversation, so it remembers last tick). `channels.webhook` makes the hook address
the agent's inbox: the platform reads the text off the declared path, runs the turn
and sends the reply through the connector with `$reply`, `$conversation` and `$text`
filled in. Point Telegram's `setWebhook` at the hook address and store the bot token
under the `telegram` connector; that is the whole bot. Paths are dotted
(`body.items[0].text`); the hook door still verifies a stored signature first.

Other inboxes are the same declaration with another `reply`. Twilio posts a form,
so the paths are `text: 'body.Body'`, `conversation: 'body.From'`, and the reply is
form-encoded to the Messages endpoint (SMS and WhatsApp alike):

```js
reply: { connector: 'twilio', form: true,
         url: 'https://api.twilio.com/2010-04-01/Accounts/<ACCOUNT_SID>/Messages.json',
         body: { To: '$conversation', From: '<YOUR_TWILIO_NUMBER>', Body: '$reply' } }
```

Slack Events API: `text: 'body.event.text'`, `conversation: 'body.event.channel'`, reply
through the `slack` incoming-webhook connector with `body: { text: '$reply' }`.

## Long tasks: `AcuvoAgent.run`

```js
const run = await AcuvoAgent.run('researcher',
  'Find the five best-rated plumbers near Manly, save each to leads, then email me the list',
  { maxTurns: 10, onProgress: (r) => renderLog(r.log) });   // resolves when done | failed | cancelled
```

The platform runs the agent one turn at a time on its own queue — each turn a fresh
budget with the usual tools and memory — keeps a log, publishes progress on the live
channel `agent-run:<id>`, and stops when the agent begins a reply with `DONE:` or the
turns run out. `run.result` is the summary, `run.log` the turns. `AcuvoAgent.runStart`
returns `{ runId }` at once; `runStatus(name, id)`; `cancel(name, id)`. From a function or
another agent's tool: `ctx.agent.run(name, goal)`. Say in `system` that on a run it works
alone, one concrete step per turn, and must begin with `DONE:` when finished.

**A human gate.** Put `approve: true` on a tool (a refund, a payment, an email to a
customer, a delete) and the platform will not run it: the run PAUSES on that exact call,
the owner is emailed and approves or declines it in the project's Data view, and the
run resumes with a one-use grant (approved) or the refusal (declined). Nothing the
agent says can bypass it. On a page chat the reply carries `pending: { name, args }`
so the page can say what it is waiting for.

## Long-term memory

`memory: 8` keeps the last turns of ONE conversation. `recall: true` gives the agent a `recall`
tool that searches ALL its past conversations by meaning ("what did the person with the
leaking tap need?") and returns dated excerpts — a receptionist that remembers callers, a
desk that knows what was promised last week. Opt in deliberately: it crosses visitors, so
never combine it with a system prompt that repeats personal details to strangers.

## Show the work

`AcuvoAgent.chat('support', text, { onProgress: (s) => setStatus(s) })` — while the turn runs the page
receives `{ kind: 'thinking' }`, `{ kind: 'tool', name, args }`, `{ kind: 'tool-result', name, ok }`,
`{ kind: 'pending', name }`, `{ kind: 'delta', text }` (the reply's words as they are
written — append them to the bubble) and `{ kind: 'reply' }` through the live door, so a chat shows
"Looking up order 42…" instead of a spinner. A run publishes the same on `agent-run:<id>`.

## Teams

An agent's tool can ask another agent: `run: async (a, ctx) => (await ctx.agent.chat('pricing', a.question)).reply`.
So a `supervisor` with tools `ask_pricing`, `ask_support`, `book` delegates to specialists that
each hold their own system, tools and memory, and answers the visitor once. Two hops at most
(a supervisor asks a specialist, which may ask one more); a third is refused by the platform,
so a team cannot loop. Give the supervisor a conversation key per visitor and let specialists
be stateless unless they need memory. For a long job, a tool may `ctx.agent.run(...)` instead
and report the run id.

## Rules

- **Tools are the agent's hands. Give it the ones the brief needs, named as
  verbs**, with a one-line description and a real JSON schema. Under eight.
- **Never trust a tool argument.** It came from the model, which read it from a
  visitor. Validate ids, cap lengths, check ownership before a write.
- **Keep `system` to what the agent IS and how it decides**, not a manual.
  Facts that change belong in `before` or in a tool.
- **The page shows the reply as text, not HTML.** A visitor's words pass through
  the model into the reply; escape before it reaches the DOM.
- **Memory is per conversation, not per person**, unless you key it: from a
  function pass a stable `conversationId` (a chat id, a user id); the page's id
  is per tab.

## What it is not

Not `AcuvoAI` (a persona with no hands, for a page that only talks). Not a
schedule or a job (it answers when asked). Not a place to hide a key: reach a
service through a connector.

## On the phone

The same agent can answer a call. When the owner points their Acuvo voice number at
it, each thing the caller says becomes one turn of `agents/<name>.js` (tools, memory,
approvals and the ledger all as in chat) and the reply is spoken. Nothing to write in the
app; keep replies short and plain, and let `book`/`lookup` tools do the work.

## Any MCP server the owner connected

The owner can connect MCP servers to their account (HubSpot, a calendar, a
warehouse, anything that speaks MCP). An agent tool or a server function can
use them — the same guarded tools the platform's own chat may call, nothing more:

```js
const { servers } = await ctx.mcp.list();          // [{ name, tools: [{ name, description }] }]
const r = await ctx.mcp.call('hubspot', 'search_contacts', { q: args.email });
return r.content;                                  // the server's result, bounded
```

Python: `ctx.mcp.list()`, `ctx.mcp.call(server, tool, args)`. Server-only (the
owner's credentials never reach a page), 500 calls per app per day. A tool that
changes something in the owner's system belongs behind `approve: true`.
