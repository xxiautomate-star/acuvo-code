---
name: api-design
description: What a generated app can and cannot fetch, plus REST shapes, status codes and pagination for a real server
when: When the app needs to fetch or call an API, or when adding a route to a server you own
---

# Talking over the network

## ⚠️⚠️ Reach another host through `AcuvoProxy` — a direct `fetch` is refused by CSP

The page is served under a `connect-src` that names **only this app's own
endpoints** — never `'self'`, never `https:`. Everything else in the universe is
refused by the browser before a packet leaves.

```js
✗ fetch('https://api.openweathermap.org/...')   // blocked by CSP. Always. In every runtime.
✗ fetch('https://api.stripe.com/...')           // same
✗ new WebSocket('wss://...')                    // same

✓ await AcuvoProxy.fetch('open-meteo', 'https://api.open-meteo.com/v1/forecast?...')
✓ await AcuvoProxy.fetch('stripe', 'https://api.stripe.com/v1/charges', { method: 'POST', body })
```

`AcuvoProxy.fetch(name, url, init)` returns a normal `Response`. Our server makes
the call and **injects the owner's key server-side**, so no key ever reaches the
page — which is the real rule underneath the CSP one: *a key in a page you hand
out on a link was never yours to spend.* **Never put a key in the code.**

There are 35 named connectors; `third-party-apis` lists every name and call.
Several need no key at all — `open-meteo`, `exchange-rates`, `wikipedia`,
`coingecko`, `nominatim`, `restcountries`, `dictionary`.

⭐ **So build the feature with what is actually reachable**, and say plainly in the
UI where the numbers come from:

⚠️ **Every one of these is injected, not imported, and may be absent.** Guard each
use — `if (window.AcuvoData) { … }` — and make the app fully usable without it.
The brief decides which are present; none of them is something you install.

- **Data the app owns** → `window.AcuvoData` (see `state-management`). This is the
  backend. It is a real server-side store, not a mock.
- **Accounts** → `window.AcuvoAuth` (see `auth-and-sessions`).
- **A picture or a spoken line, made on demand** → `window.AcuvoMedia` —
  `AcuvoMedia.image(prompt)` returns a durable URL, `AcuvoMedia.speak(text)` a WAV.
  Slow and rate-limited: show a placeholder first, never call it in a loop.
- **A question that needs a model** → `window.AcuvoAI`. This is how an app
  answers, writes, summarises or converses. Bounded on the server; you cannot
  widen it from the page. ⭐ **And it is not a general chatbot: when the owner
  has uploaded documents — an FAQ, a price list, a policy — it answers FROM
  them and names the document it used.** You call nothing extra for that;
  retrieval happens on our side inside the same `AcuvoAI.ask()`. See *Never
  hardcode the business's own facts* below.
- **A file from the person using the app** → `window.AcuvoFiles`.
  `AcuvoFiles.upload(file)` takes a `File` from an `<input type="file">` and
  returns a permanent URL. Images, PDF, CSV, text, JSON, DOCX, XLSX, up to 5 MB.
  ⚠️ The URL is public: never build an upload for identity documents.
- **THEIR OWN accounts — their Gmail, calendar, GitHub, Slack, Notion** →
  `window.AcuvoConnections`. Each end user connects their own account; the token
  stays on our server and the app never sees it. Requires `AcuvoAuth` sign-in.
- **Taking money** → `window.AcuvoPay` hands the buyer the payment link the
  OWNER set up in their own payment account. Check `await AcuvoPay.methods()`
  first: hide the button when `configured` is false, and show `reason` when
  `available` is false (preview and share links cannot take money; the deployed
  site can). Amounts are whole cents. Record the order in `AcuvoData` yourself.
- **Telling the OWNER something happened** (a booking, an enquiry, a form
  submission) → `await AcuvoEmail.send({ subject, text, html?, replyTo? })`
  reaches the inbox of the business that owns the app. Pass the visitor's address
  as `replyTo` so the owner can answer. ⚠️ **There is no recipient you can
  choose** — it reaches the OWNER and nobody else, so never promise a visitor a
  confirmation email and never use it for customer-facing mail. Save the
  submission with `AcuvoData` FIRST; the email is a heads-up on a saved record,
  never the record. In a `functions/<name>.js` handler it is `ctx.email.send(…)`.
- **Something genuinely external and public** (a live exchange rate, today's
  weather, a stranger's REST API) → `AcuvoProxy.fetch(name, url)`. A live rate
  and today's weather are two of the KEYLESS connectors we built on purpose
  (`exchange-rates`, `open-meteo`) — they need no key from anyone. A host with
  no connector genuinely cannot be reached: let the user enter the value, ship
  it as data in the page, or design the feature so it does not need it.
  **Never fake it and call it live.**

⚠️⚠️ **"External" is not the same as "the user's own data".** A public API is
unreachable; the signed-in person's own inbox and calendar are reachable through
`AcuvoConnections`, because our server holds the token and makes the call. Do not
tell someone their calendar cannot be read — read it.

⚠️ `<img src="https://…">` and a Google Fonts stylesheet DO load — `img-src` and
`style-src` are wider than `connect-src`. That is images and fonts, not data. You
still cannot read a JSON response.

## ⭐ What survives the deploy — as of 2026-09-08, all of it

A generated app reaches people at **three** addresses, and they now carry the
same capabilities at all three:

| | builder preview | share link `/p/…` | **the customer's own domain** |
|---|---|---|---|
| `AcuvoData` `AcuvoAuth` `AcuvoFiles` `AcuvoEmail` | yes | yes | **yes** |
| `AcuvoMedia` `AcuvoAI` `AcuvoConnections` | yes | yes | **yes** |
| `AcuvoAgent` `AcuvoFunctions` `AcuvoJobs` `AcuvoLive` `AcuvoProxy` `AcuvoWeb` `AcuvoSchedule` | yes | yes | **yes** |

⚠️ **`AcuvoNotify` IS GONE**, replaced by `AcuvoEmail`. It is injected on no
runtime; code that names it throws for a real visitor. If any two lines here ever
disagree about a client, the injected list wins — `lib/app-client-stubs.ts`.

⭐ **`if (window.AcuvoAI)` is still not boilerplate** — every client is gated per
project and per plan, and a guard costs one line.

⭐ **So design the fallback as a real path, not a disabled control.** An FAQ ask
box that vanishes on the live site leaves a customer with nowhere to ask:

```js
if (window.AcuvoAI) {
  mountAskBox();                    // preview + share link
} else {
  showContactPanel();               // the deployed site: phone, form, hours
}
```

The page must be genuinely useful with any of them absent; never render a
control that does nothing.

## ⚠️⚠️ Never hardcode the business's own facts

Every generated page does this:

```html
✗ <p>Callout fee: $89. Open 7am–5pm weekdays.</p>
```

They came from a brief typed once: wrong the day a price changes, unfixable
without a rebuild, and never right at all if you guessed them.

```html
✓ <p>Ask us anything — we answer from our own price list and policies.</p>
```

⭐ **Put the facts in the knowledge base, put the question box on the page.**
The owner adds documents on their project page, under *"What this app knows"*,
and everything they add is answerable from that moment with no rebuild. An
`AcuvoAI` ask box is therefore the RIGHT shape for an FAQ section, a support
widget or a pricing question — and a hardcoded FAQ list is the wrong one.

⚠️ Facts the owner actually gave you in the brief — the address, the phone
number, the business name — are fine to show. It is **prices, hours, fees,
policies and anything that changes** that belong in the documents.

⚠️ **Let it say "I don't know".** The assistant is instructed to answer from the
documents and to say plainly when they do not cover something. Do not prompt
around that: a persona line like *"always give the customer an answer"* fights
the grounding and produces invented prices, which is worse for the business than
an unanswered question — a made-up quote is one the customer will hold them to.

```js
✓ 'You are the assistant for Reed Plumbing, a plumber in Ipswich. Be warm and brief.'
✗ 'You know everything about Reed Plumbing. Never say you do not know.'
```

⚠️ And render the reply with `textContent`, never `innerHTML` — the text came
back from a model that read documents somebody uploaded.

## ⚠️ A plain form post goes nowhere either

`form-action 'none'`. `e.preventDefault()` and handle it in JavaScript — see
`forms-and-validation`.

---

# Designing an API on a server you actually own

Everything below is for the CLI working in a real repo: a Next.js route handler,
an Express app, a worker. None of it applies to a generated single-page app.

## Nouns in the path, verbs in the method

```
✗ POST /createInvoice        ✗ GET /getInvoiceById?id=7
✓ POST /invoices             ✓ GET  /invoices/7
✓ PATCH /invoices/7          ✓ DELETE /invoices/7
```

`GET` never changes anything — crawlers, prefetchers and browser history all assume
that, and one of them will eventually prove it.

## Status codes are the API's error handling

| code | meaning | the mistake it prevents |
|---|---|---|
| 200 | here it is | — |
| 201 | created, `Location:` points at it | 200 with a body you must parse to learn the id |
| 400 | your request is malformed | using 500 for a typo |
| 401 | who are you? | conflated with 403 |
| 403 | I know who you are; no | conflated with 401 |
| 404 | no such thing | 200 with `{"error":"not found"}` |
| 409 | conflicts with current state | 400 for a duplicate |
| 422 | shape is fine, values are not | 400 for everything |
| 429 | slow down | silence |
| 507 | out of room | 500 for a quota |
| 500 | **we** broke | blaming the caller |

⚠️ `200 {"success": false}` forces every client to parse a body to discover failure,
and defeats every retry, cache and monitor in the path.

## ⚠️⚠️ Idempotency: the network will deliver twice

A client that times out will retry. Without an idempotency key, the customer is
charged twice and the receipt is genuine.

```
POST /payments
Idempotency-Key: 8f3a…            ← client-generated, stored with the result
```

Same key → return the FIRST result, do not perform the work again. `PUT` and
`DELETE` are naturally idempotent; `POST` is the one that needs help.

## Pagination: never return everything

`GET /invoices` on a table that grows is a timeout waiting for a customer big enough
to trigger it.

- **Offset** (`?page=3&limit=50`) is simple and drifts: rows inserted while paging
  shift the window and items are seen twice or missed.
- **Cursor** (`?after=<opaque>&limit=50`) is stable and is what to use for anything
  ordered by time.

Always cap `limit` server-side. A client asking for 1,000,000 gets your maximum, not
an outage. ⭐ Return the **total** as well as the page — a client that cannot tell
"50 of 50" from "50 of 300" will show the first page as if it were everything.

## Consistent shapes

```json
{ "data": [...], "next_cursor": "…" }
{ "error": { "code": "invoice_not_found", "message": "No invoice with id 7" } }
```

A machine-readable `code` plus a human-readable `message` — clients branch on the
code, humans read the message. Never make a client match on prose.

## Versioning, dates and money

- Version before you need it: `/v1/`. Removing a version is a conversation; breaking
  an unversioned API is an outage.
- Timestamps in **UTC ISO-8601** with an offset. Never a bare local time.
- Money in **integer minor units** with a currency (`{"amount": 1250, "currency":
  "AUD"}`). Floating point and money do not belong together.
