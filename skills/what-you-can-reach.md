---
name: what-you-can-reach
description: The index of everything a generated app can reach on this platform — every runtime global, every server-side door, every named third-party API — one line each, so you never assume a capability is missing.
when: Before saying "that is not possible here", before writing a plain fetch to another host, or when the brief wants something outside the page (records, sign-in, uploads, payments, email, a schedule, an API, a model).
---

# What you can reach

Every generated page runs with these globals injected. None needs a key from
the person building; the owner adds keys only for the named APIs at the end.
Open the skill named in the right column before using one.

## In the page (window globals)

| global | what it does | skill |
|---|---|---|
| `AcuvoData` | records: `list/get/set/remove`, `search(collection, text)`, `watch(collection, onChange)` for live updates; `AcuvoData.private` is the signed-in person's own store | data-and-charts, live-data |
| `AcuvoAuth` | app-user sign-in by email code or `signInWithGoogle()`; `me()`; sessions | auth-and-sessions |
| `AcuvoFiles` | visitor uploads to 5 MB (images, PDF, CSV, audio, video): `upload/list/remove`; `AcuvoFiles.private` | app-files |
| `AcuvoFunctions` | `call('<name>', args)` runs `functions/<name>.js` on the server | app-functions |
| `AcuvoProxy` | `fetch('<connector>', url, init)` calls a named third-party API with the owner's key injected, or a keyless public API | third-party-apis |
| `AcuvoAI` | `chat(messages, { system })` — the platform's own model, no key, metered per app | agent-in-a-page |
| `AcuvoEmail` | `send({ subject, text })` emails the app's owner (nobody else) | app-email |
| `AcuvoAgent` | `chat('<name>', text)` talks to an agent the app defines in `agents/<name>.js` (persona, memory, tools over the app's own data); the platform runs the loop and keeps the conversation | build-an-agent |
| `AcuvoLive` | `join('<channel>', onMessage)` → `room.send(payload)`, `room.leave()`: messages between the people using the app right now (chat, presence, a shared board); ephemeral | realtime |
| `AcuvoJobs` | `enqueue('<fn>', args)` runs a server function later with retries and keeps the result; `wait(id)` returns when done: imports, reports, sends, chained slices | background-jobs |
| `AcuvoWeb` | `search(q)` → results and `read(url)` → a page's readable text: today's internet, keyless, because a page cannot fetch other sites | live-web |
| `AcuvoSchedule` | `set('<name>', { every: '15m', fn: '<function>' })` runs a function on the clock | app-functions |
| ⛔ `AcuvoPay` | **NOT AVAILABLE — the client is not injected.** The door exists (`/api/app-payments`) and the client **is not injected** on any runtime — measured 2026-09-08 against `app/p/[token]`, its sub-path route and `app/s/[slug]`, all three. Code that names it is a dead button in every place a customer sees the app. Take payment through a link the owner pastes in, until this row says otherwise. | money-and-totals |
| `AcuvoMedia` | `image(prompt, options)` generates a picture for the app on the platform's own engine, stored and served | creative-engines |
| `AcuvoBoard` | `render(scene)` returns SVG markup for a drawn explainer — labelled shapes, plotted functions, KaTeX maths, bar/Gantt charts, staged reveals; `into(selector, scene)` draws it straight into an element. A `frames` array makes it CLICK-THROUGH (each frame has `text` and optional `options` with `label`/`correct`/`response`) and the board handles asking, scoring and advancing — a quiz, flashcards, a worked proof. Use `into` for those: it activates the walk. | sketch-and-explain |
| `AcuvoConnections` | the owner's connected services (calendar, CRM) where granted | supabase-multitenant |

## On the server (inside `functions/<name>.js` or `functions/<name>.py`, the `ctx` object)

`ctx.data` (the shared store) · `ctx.agent.chat(name, text, conversationId)` (an agent the app defines) · `ctx.live.send(channel, payload)` (wake every page on a channel) · `ctx.jobs.enqueue` (the next slice, later, with retries) · `ctx.web.search/read` (the live internet) · `ctx.sql(text, params)` (the app's own Postgres schema; migrations in `migrations/NNNN_x.sql`) · `ctx.proxy.fetch(connector, url, init)` · `ctx.ai.chat(messages, { system })` (the platform model) · `ctx.email.send({ subject, text })` · `ctx.files.list/readText/remove` · `ctx.log`. A file named `functions/on-<collection>.js` runs after every change to that collection with `{ event: 'set' | 'remove', key, value }` (a data trigger). A function also receives inbound **webhooks** at `/api/app-hooks/<token>/<name>` (Stripe-signed or HMAC) and **schedule** ticks with `{ schedule, rows }`. Ten seconds, 25 calls, no `require`.

## Named third-party APIs (through `AcuvoProxy` / `ctx.proxy`)

openai · anthropic · gemini · groq · openrouter · deepseek · huggingface · elevenlabs · fal · replicate · unsplash · pexels · stripe · notion · airtable · google-sheets · github · youtube · brave-search · tavily · newsapi · google-maps · mapbox · openweather · telegram · discord · slack · twilio — and keyless: open-meteo · exchange-rates · wikipedia · restcountries · coingecko · nominatim · dictionary.

## What is NOT here

No `require` of npm packages in the shipped app beyond react and react-dom (the vendor shelf carries the rest as scripts under the CSP rules). Server functions are JavaScript or Python (standard library, no pip). No process that runs longer than ten seconds; chain a schedule for long work. No OAuth consent screens for third parties; a service that needs one is not offered yet.
