---
name: working-in-the-background
description: Servers, watchers and long builds without blocking — start_process and wait_for_output
when: Any command that does not exit — a server, a watcher, a long build, anything running WHILE you work
---

# Working In The Background

## ⚠️⚠️ `run_command` is for commands that FINISH

A dev server never finishes. Starting one with `run_command` blocks until the
timeout and then reports a failure for something that was working perfectly.

**Use `start_process` for anything that keeps running:** a dev server, a
watcher, a build in watch mode, a queue worker.

## ⭐⭐ The sequence that works every time

1. **`start_process`** — launch it. You get an `id` back.
2. **`wait_for_output`** — block until the line that means READY appears
   (`Ready in`, `Listening on`, `compiled successfully`).
3. **`check_process`** — read what it printed, confirm it is still alive, and —
   if it announced a port — confirm it is **actually answering HTTP**.
4. Do your work.
5. **`stop_process`** — stops it and everything it started, returns final output.

⭐ **`wait_for_output` instead of guessing.** Sleeping "about thirty seconds"
is wrong in both directions: too short and you test a server that has not
started, too long and you waste half a minute on every run. Wait for the line.

## ⚠️⚠️ Waiting for ONLY the success line will hang on a crash

If the process dies during startup, the ready line never comes and you sit
there until the timeout learning nothing.

⭐ **Wait for a pattern that also matches failure** — `Ready in`, but also
`Error`, `EADDRINUSE`, `Cannot find module`. Then read the output and find out
which happened. **Silence is not success**, and a wait that can only end one way
turns a five-second crash into a two-minute mystery.

## ⭐ A port answering is the only proof it started

`check_process` tells you whether the port actually responds. Use that, not the
log line — a framework can print "Ready" and still fail the first request. If
you are about to test a page, confirm the port answers first, or you will spend
the next three steps debugging your test instead of the app.

## ⚠️ Long logs: `summarize_log`, not the whole thing

A watch-mode build produces thousands of lines. `summarize_log` folds it to the
errors and warnings first, then the tail, then **an exact count of what was left
out** — so you know whether you are seeing everything.

Reading a 4,000-line log in full costs a large part of your context and usually
tells you one thing you could have had from the summary.

## ⭐ Clean up

**Stop what you started.** A dev server left running holds its port, and the
next run fails with `EADDRINUSE` — which reads like a broken app and is not.
If a port is busy, check whether YOU left something on it before concluding
anything about the code.

Related skills: `debugging`, `verify-your-own-work`.

## Workflows: steps, waits and branches in one file

```js
// workflows/abandoned-cart.js — registered when the build is saved
module.exports = {
  on: { collection: 'carts', event: 'set' },     // or { every: '1h' } · { hook: 'stripe' } · { manual: true }
  steps: [
    async (ctx, state) => { state.cart = await ctx.data.get('carts', state.event.key); },
    { wait: '2h' },
    async (ctx, state) => { const c = await ctx.data.get('carts', state.event.key); if (!c || c.paid) return 'end'; },
    { name: 'nudge', run: async (ctx, state) => { await ctx.email.send({ to: state.cart.email, subject: 'Still thinking?', text: '…' }); } },
  ],
};
```

Each step is one queued job with `state` carried between them, so a `{ wait: '2h' }`
costs nothing and a step never holds a budget open. A step's return is its branch:
`'end'` stops, a number or a step's `name` jumps, anything else continues. `state` must
stay under 32 KB — keep keys, not documents. `on.every` becomes a schedule row;
`on.collection` fires after a set/remove with `state.event = { collection, key, value }`;
`on.hook` answers `POST /api/app-hooks/<token>/<name>`; `ctx.workflow.start('name', state)`
starts one by hand. Runs and their steps show in the owner's Data view under jobs.
