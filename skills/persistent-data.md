---
name: persistent-data
description: Data that is still there after a reload — AcuvoData's real shape, private vs shared, optimistic writes that roll back, and the reload proof
when: The app saves anything a person types or does (tasks, notes, bookings, scores, settings) and it must survive a refresh
triggers: save data, persist, persistence, refresh, disappear, lost on reload, still there after refresh, reload, database, store records, crud, todo, notes app, tracker, my own data, private data, per user, localstorage, acuvodata, saves nothing, data disappears
version: 2
applies-to: builder
---

# Data that persists

> **Building an app that adds, edits and removes records?** `read_skill("app-patterns")` first — a working form → AcuvoData → list app to edit, instead of writing the save path from scratch.

A booking form once shipped `ready` with ZERO writes and no error. The page
looked right; nothing was saved. This is the pattern that makes that impossible.
Deeper detail: `data-and-charts` (reading), `live-data` (search/watch),
`auth-and-sessions` (sign-in and `AcuvoData.private`).

## The real shape — get this wrong and the app is a picture

```
await AcuvoData.set(collection, key, value)     // value is any JSON object
await AcuvoData.get(collection, key)            // the value, or null
await AcuvoData.list(collection, { limit })     // { items: [{ key, value, updatedAt }], total }
await AcuvoData.remove(collection, key)
AcuvoData.private.*                              // same verbs, scoped to the signed-in person BY THE SERVER
```

⚠️ `list` returns **`{ items, total }`, not an array** — `(await list()).map` is
`undefined.map`. At most 200 per call, 100 by default.

⚠️ **localStorage is not persistence.** It is one browser on one device, wiped
by a private window, invisible to the owner. Use it only for UI conveniences
(a collapsed panel), never for the records.

## Private or shared — decide per collection, out loud

| the data | where |
|---|---|
| a person's own notes, tasks, journal, settings | `AcuvoData.private` (needs sign-in) |
| a booking, an order, a message TO the owner | `AcuvoData` (shared), and never render other people's rows |
| a public leaderboard, a menu, a catalogue | `AcuvoData` |

⛔ `AcuvoData.set('notes_' + user.id, …)` is NOT private — any visitor can list
it. Only `AcuvoData.private` is enforced by the server.

## One store module — the only place AcuvoData appears

```js
// js/store.js
const C = 'tasks';
export async function listTasks() {
  const { items } = await AcuvoData.private.list(C, { limit: 200 });
  return items.map((i) => ({ id: i.key, ...i.value })).sort((a, b) => b.createdAt - a.createdAt);
}
export const saveTask = (t) => AcuvoData.private.set(C, t.id, { title: t.title, done: !!t.done, createdAt: t.createdAt });
export const deleteTask = (id) => AcuvoData.private.remove(C, id);
```

Keys: `crypto.randomUUID()` for new records. Never an array index, never
`Date.now()` alone (two taps in one millisecond collide).

## Optimistic writes that roll back

Update the screen immediately, write, and put it back if the write fails —
with a message. The failure most apps ship is the first half only: the UI says
saved, the server said no, and the person finds out tomorrow.

```js
// @selftest — optimistic update with rollback, against an in-memory store that can fail
function makeFakeStore({ failOn = new Set() } = {}) {
  const rows = new Map();
  return {
    rows,
    async set(c, k, v) { if (failOn.has(k)) throw new Error('network'); rows.set(`${c}/${k}`, v); },
    async list(c) { return { items: [...rows].filter(([k]) => k.startsWith(c + '/')).map(([k, value]) => ({ key: k.slice(c.length + 1), value })), total: rows.size }; },
  };
}
async function toggleDone(state, store, id, render, notify) {
  const before = state.tasks;
  state.tasks = before.map((t) => (t.id === id ? { ...t, done: !t.done } : t));
  render(state.tasks);                                  // instant
  try {
    const t = state.tasks.find((x) => x.id === id);
    await store.set('tasks', id, { title: t.title, done: t.done });
  } catch (err) {
    state.tasks = before;                                // put it back
    render(state.tasks);
    notify(`Couldn't save — ${err.message}. Your change was undone.`);
  }
}
{
  const renders = [], notes = [];
  const ok = makeFakeStore();
  const s1 = { tasks: [{ id: 'a', title: 'A', done: false }] };
  await toggleDone(s1, ok, 'a', (t) => renders.push(t), (m) => notes.push(m));
  assert.equal(s1.tasks[0].done, true);
  assert.equal((await ok.list('tasks')).items[0].value.done, true);   // it really persisted
  const bad = makeFakeStore({ failOn: new Set(['a']) });
  const s2 = { tasks: [{ id: 'a', title: 'A', done: false }] };
  await toggleDone(s2, bad, 'a', (t) => renders.push(t), (m) => notes.push(m));
  assert.equal(s2.tasks[0].done, false);                               // rolled back
  assert.match(notes[0], /Couldn't save/);
}
```

## Load before render, every time

```js
async function boot() {
  list.innerHTML = '<p class="muted">Loading…</p>';
  try { state.tasks = await listTasks(); render(state.tasks); }
  catch (err) { list.innerHTML = `<p role="alert">Couldn't load your tasks. <button id="retry">Try again</button></p>`; }
}
```

A list rendered from a hard-coded array "so it isn't empty" is a picture of an
app. Empty is a real state: say so, and show the add button.

## ⭐ The reload proof — the check that "saves" must pass

1. Add a record through the UI.
2. Reload the page.
3. It is still there — read back through `list`, not from memory.
4. Delete it, reload, it is gone.

Until those four hold, do not say the app saves anything.
