---
name: app-patterns
description: A WORKING record app to start from — a form that validates, saves through AcuvoData and confirms; a list re-read on boot with edit and delete (optimistic, with rollback); an empty state whose button creates
when: Building a tracker, CRM, inventory, booking, quoting, orders or any app where a person adds, edits and removes records — start from this instead of writing the save path yourself
triggers: crud app, add edit delete, create read update delete, record list, records app, tracker app, button does nothing, save button does nothing, form only shows an alert, alert instead of saving, empty state, create first record, optimistic update, rollback, undo delete, edit a record, delete a record, inventory app, quote app, member tracker, job tracker, working starter app
version: 2
applies-to: builder
---

# Start from a working app, then make it this business's

The three commonest ways a generated app fails the owner — the record is gone
after a reload, the main button does nothing, the console shows an error — all
come from writing the save path from scratch. Do not. Start from the pattern.

**If reading this skill installed `index.html`**, it is the complete pattern
(about 400 lines, already proven: it saves, reloads, edits, deletes, rolls
back, validates and confirms). Edit the `APP CONFIG` block at the top of its
script and nothing else until that works:

```
title, intro            the business's own words
collection, noun        'jobs', 'job'  → "Add job", "No jobs yet"
fields                  the FIRST field names the record and is the one required field
                        types: text · textarea · number (min, step, money) · email · tel · date (today) · select (options)
status                  { key: 'stage', options: ['New', 'Contacted', 'Closed'] } → a select on every row, saves on change
actions                 [{ label: 'Record sale', when: r => r.qty > 0, apply: r => ({ qty: r.qty - 1 }) }]
figures(rows)           the live numbers across the top (totals, counts, overdue, low stock)
describe(r)             the line under each row's name
validate(data, others)  a whole-record rule: return 'That slot is taken.' to refuse, '' to allow
refreshSeconds          re-read every N s so a second screen sees new records (0 = off)
samples                 3–6 realistic records for THIS business, written once on first open
```

In a Vite + React + TypeScript project the same pattern is `src/app.config.ts`
(edit) over `src/screens/Records.tsx`, `src/data/records.ts` and
`src/lib/optimistic.ts` (already working).

## The four rules the pattern keeps — keep them when you extend it

1. **Every record goes through `AcuvoData.set` and the list is re-read with
   `AcuvoData.list` on boot.** Never `alert('Saved!')`, never `localStorage`,
   never an in-memory array that a reload empties. `list` returns
   `{ items: [{ key, value }], total }`, not an array.
2. **The create form is the first form on the first screen, and its first
   field alone is enough to create a record.** Pressing Enter in it saves.
   A search box goes after it, never above it.
3. **Every action says what happened on the page**: "Added “Smith Plumbing”.",
   "Deleted … Undo", or "Not saved — … Nothing was changed." A failed save puts
   the screen back (rollback) instead of lying.
4. **An empty list is a call to action**: "No jobs yet." plus a button that
   takes the person to the form.

## The core, if nothing was installed

```js
// The ONLY place the store is called.
const COLLECTION = 'jobs';
const newId = () => 'job-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
async function load() { const { items } = await AcuvoData.list(COLLECTION, { limit: 200 }); return items.map((i) => ({ ...i.value, id: i.key })); }
async function persist(r) { const { id, ...value } = r; await AcuvoData.set(COLLECTION, id, value); }

// Optimistic update with rollback: change the screen now, save, undo the change if the save is refused.
async function optimistic(state, next, save, render, say) {
  const before = state.rows;
  state.rows = next; render();
  try { await save(); return true; }
  catch (e) { state.rows = before; render(); say('Not saved: ' + e.message + '. Nothing was changed.', true); return false; }
}

// The form: validate, save, confirm, reset, focus the first field again.
async function onSubmit(e, state, form, render, say) {
  e.preventDefault();
  const name = form.elements.name.value.trim();
  if (!name) { form.elements.name.setAttribute('aria-invalid', 'true'); say('Name is required.', true); return; }
  const r = { id: newId(), name, createdAt: Date.now() };
  if (await optimistic(state, [r, ...state.rows], () => persist(r), render, say)) {
    form.reset(); say('Added “' + name + '”.'); form.elements.name.focus();
  }
}
```

```js
// @selftest — the save path survives a "reload" and a refused write rolls back
const db = new Map();
let refuse = false;
const AcuvoData = {
  async set(c, k, v) { if (refuse) throw new Error('store full'); db.set(c + '/' + k, v); },
  async list(c) { return { items: [...db].filter(([k]) => k.startsWith(c + '/')).map(([k, value]) => ({ key: k.slice(c.length + 1), value })), total: db.size }; },
};
const COLLECTION = 'jobs';
async function load() { const { items } = await AcuvoData.list(COLLECTION, { limit: 200 }); return items.map((i) => ({ ...i.value, id: i.key })); }
async function persist(r) { const { id, ...value } = r; await AcuvoData.set(COLLECTION, id, value); }
async function optimistic(state, next, save, render, say) {
  const before = state.rows; state.rows = next; render();
  try { await save(); return true; } catch (e) { state.rows = before; render(); say(e.message, true); return false; }
}
const state = { rows: [] };
const said = [];
const ok = await optimistic(state, [{ id: 'job-1', name: 'Fix tap' }], () => persist({ id: 'job-1', name: 'Fix tap' }), () => {}, (t) => said.push(t));
assert.equal(ok, true);
assert.deepEqual(await load(), [{ name: 'Fix tap', id: 'job-1' }]); // a reload reads it back
refuse = true;
const bad = await optimistic(state, [...state.rows, { id: 'job-2', name: 'Lost' }], () => persist({ id: 'job-2', name: 'Lost' }), () => {}, (t) => said.push(t));
assert.equal(bad, false);
assert.equal(state.rows.length, 1); // rolled back
assert.deepEqual(said, ['store full']);
```

Beyond the list: more screens (a detail view, a calendar, a kitchen board) are
more files reading the SAME data layer — never a second copy of the records.
Sign-in, roles and private rows: `auth-and-sessions`. Searching and live
updates: `live-data`.
