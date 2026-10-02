---
name: state-management
description: Where data lives — save, store and load records so a todo, list, tracker or booking survives a refresh
when: When saving or loading data, when two components disagree, or before you type localStorage
---

# State, and where data actually lives

## ⚠️⚠️ In a generated Acuvo app, `localStorage` is NOT the browser's localStorage

This is the single most expensive mistake available here. Measured across 18
generated apps: **0 used the real store, 12 used `localStorage`.** None of them
kept a record.

Your page runs sandboxed (`sandbox allow-scripts allow-forms`), which puts it in
an **opaque origin**. The platform then patches over the wreckage, and what your
code gets depends on where the page is running:

| where | what `localStorage` actually is | what that means |
|---|---|---|
| the **builder preview** (the pane the owner watches) | an in-memory object, swapped in because the real one throws `SecurityError` on access | **forgets everything on reload** |
| the **shared link** `/p/<token>` | one server-side blob keyed by the SHARE TOKEN, inlined into the HTML | **every visitor shares it**, and it is visible in View Source |
| a downloaded/exported file | the browser's real one | per-browser, per-device |

So `localStorage` never throws — it silently does the wrong one of three things.

⛔ `document.cookie` and `indexedDB` are **not** patched. In the opaque origin
they genuinely throw or return nothing. Do not reach for either.

## ⭐ The real store: `window.AcuvoData`, already injected

Never define it, never `fetch` a URL, never write a token. It is already on
`window` before your first script runs.

```js
await AcuvoData.set('tasks', id, { text, done: false }); // create or replace one record
await AcuvoData.get('tasks', id);                        // that value, or null if never saved
await AcuvoData.list('tasks');                           // { items: [{ key, value, updatedAt }], total }
await AcuvoData.list('tasks', { limit: 50, offset: 50 }); // page two
await AcuvoData.remove('tasks', id);                     // deleting something absent is a success
await AcuvoData.clear('tasks');                          // empty the whole collection
```

- `list` returns **`{ items, total }`, not an array.** `items.length` is what you
  were given; `total` is what exists. `items.map(...)` on the result is
  `undefined.map` — read `items` first.
- Items come back **newest-WRITTEN first** — the store's order, not your
  record's date. A "recent" list or a history sorts by its own field:
  `items.sort((a, b) => b.value.date.localeCompare(a.value.date))`.
- Every verb returns a Promise and **rejects** on failure. See `error-handling`.
- `collection` and `key` must match `[A-Za-z0-9_-]{1,64}`. A title, an email or a
  date with slashes is **not** a legal key — slug it, or use an id:

```js
const id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2));
const slug = String(title).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
```

## ⭐ The line is OWNERSHIP, not lifetime

Every record the **app owns** goes in `AcuvoData`: tasks, bookings, contacts,
expenses, orders, messages, entries, scores, notes.

`localStorage` keeps exactly one class of thing: **how this one visitor likes the
screen** — theme, collapsed sidebar, last filter, sound on/off. Three examples,
and that is the whole list.

⚠️ *"It's just one person's data"* is not a reason to skip the store. One person
still uses a phone and a laptop, and clears a cache.

## ⚠️⚠️ It is a SHARED, PUBLIC notebook

Whoever holds the app's link can read **and overwrite** every record. That is not
a bug to be fixed later; it is what a link-shared app honestly is.

- Never put a password, an API key or a token in it.
- Never describe it in UI copy as "your private data" or "your account's data".
- Scoping records by user id (`AcuvoData.set('notes_' + user.id, ...)`) is
  **organisation, not security**, and neither is filtering in the browser.

⭐ **When a record belongs to ONE PERSON, there is a real answer:
`AcuvoData.private`** — the same five verbs, scoped by the SERVER to the
signed-in `AcuvoAuth` account, filtered in SQL so no account can read or
overwrite another's.

```js
await AcuvoData.set('menu', id, dish);            // shared: everyone with the link
await AcuvoData.private.set('orders', id, order); // private: only this account
```

It needs a signed-in user, because there is no owner without one. See
`auth-and-sessions`.

## The async trap that makes an app look broken

Reads are network round trips. Render order is the bug:

```js
✗ let tasks = [];
  AcuvoData.list('tasks').then(r => { tasks = r.items; });
  render(tasks);            // runs FIRST, with [], and never runs again

✓ async function refresh() {
    const { items } = await AcuvoData.list('tasks');
    render(items);
  }
  refresh();                // and call it again after every write
```

⭐ Hold the list in one variable, mutate that, re-render from it, and write to the
store. One source of truth in memory, one in the store, and they are updated by
the same function — never two code paths that both draw.

## Caps — server-enforced, and a refusal is thrown, never a silent truncate

`AcuvoData`, per app: **1,000 records · 1 MB total · 64 KB per value · names up to
64 characters.** `list` returns **100 records by default** and at most 200 —
which is why `total` exists and why a page that ignores it silently shows the
first 100 of 300 while looking perfectly correct.

The patched `localStorage` snapshot is much tighter: **500 keys, 512 bytes per
key, 64 KB per value, 256 KB total**, writes debounced ~350 ms, and keys starting
`__acuvo` silently dropped. One more reason not to build records on it.

## One source of truth. Derive everything else.

Two parts of the screen disagreeing is almost always two copies of one fact.

```js
✗ let items = [...]; let itemCount = 0;             // now they can differ, and they will
✓ let items = [...]; const count = items.length;    // derived, cannot drift
```

If a value can be computed from another, **compute it**. A cached derived value
is a second source of truth wearing a disguise. Persist the minimum: an id, not
the object it points at; a filter, not the filtered result.

## ⭐⭐⭐ MORE THAN ONE SCREEN: use htmPreact, not `innerHTML =`

The biggest gap in what we have shipped. Across 55 generated benchmark files:
**44 whole-view `innerHTML =` rebuilds and ZERO apps with a view you could link
to.** `innerHTML =` destroys the DOM it replaces — the text a user is halfway
through typing and the element that had focus both disappear on every
re-render. That is the single most common reason a generated app *feels* broken.

`/vendor/htm@3.1.1/standalone.umd.js` (see `vendor-shelf`) is Preact + hooks +
htm in one classic script. No JSX, no build step, no `eval` — and its diffing
keeps focus and input values across a re-render.

```html
<div id="root"></div>
<script src="/vendor/htm@3.1.1/standalone.umd.js"></script>
<script>
const { html, render, useState, useEffect } = htmPreact;

function Row({ job, onDone }) {
  return html`<li class="row">
    ${job.title}<button onClick=${() => onDone(job.id)}>done</button>
  </li>`;
}

function App() {
  const [route, setRoute] = useState(location.hash.slice(1) || '/');
  const [jobs, setJobs] = useState([]);

  // ⭐ THE WHOLE ROUTER. Views become linkable and the back button works.
  useEffect(() => {
    const f = () => setRoute(location.hash.slice(1) || '/');
    addEventListener('hashchange', f);
    return () => removeEventListener('hashchange', f);
  }, []);

  useEffect(() => { AcuvoData.list('jobs').then(r => setJobs(r.items)); }, []);

  return html`<div>
    <nav><a href="#/">Jobs</a> <a href="#/settings">Settings</a></nav>
    ${route === '/settings'
      ? html`<${Settings} />`
      : html`<ul>${jobs.map(j =>
          html`<${Row} key=${j.key} job=${j.value} onDone=${done} />`)}</ul>`}
  </div>`;
}
render(html`<${App} />`, document.getElementById('root'));
</script>
```

`htmPreact` holds `html render h Component createContext` and the hooks
`useState useReducer useEffect useLayoutEffect useRef useMemo useCallback
useContext` — nothing else.

⚠️ Six things that each cost a round:

- **The markup is a tagged template, not JSX.** `` html`<div>…</div>` `` — the
  backticks are part of the call. `html(<div/>)` is a syntax error.
- ⚠️⚠️ **htm does NOT decode HTML entities.** `Sable &amp; Co` and `a &middot; b`
  reach the screen literally — measured, 2 apps of 5. Type the character itself
  (`&`, `·`, `—`, `→`); for a non-breaking space use `${' '}`.
- **A component is closed with `<//>`**, not with its name:
  `` html`<${Panel}>text<//>` ``. Self-closing `` html`<${Row} job=${j} />` `` is
  fine and is what you want most of the time.
- ⚠️⚠️ **Every item in a list needs `key=${…}`.** Without it the reconciler
  matches children by position, and the focus-and-typing preservation that is
  the entire reason to use this silently stops working.
- **There is no router library and you do not need one.** The seven-line
  `hashchange` effect above is it. ⚠️ `<a href="#/settings">` is a hash link and
  is correct inside ONE document. It is NOT the same thing as a second page —
  if the brief asks for separate pages, write separate `.html` files with
  ordinary `<a href="about.html">` anchors instead; a JS router is not
  navigation there and the link checker cannot follow it.
- **`AcuvoData` is async.** Load in a `useEffect`, hold the rows in `useState`,
  and never render from a promise.

## Where the rest of state should live

In order — take the first that works:

1. **In the component that uses it.** Most state is local and should stay there.
2. **In the nearest common parent**, when two siblings need it.
3. **In the URL**, when it should survive a refresh or be shareable — filters, the
   current tab, a search query, pagination. Under-used, and free.
4. **In `AcuvoData`**, when it is a record the app owns.
5. **In a global store**, only when many distant parts genuinely need it.

## Never mutate what you are about to compare

```js
✗ state.items.push(x);            // same reference — a change detector sees nothing
✓ state = { ...state, items: [...state.items, x] };
```

This is the cause of "the data is right but the screen did not update".

## Server data is not UI state

Fetched data has its own concerns — loading, error, stale, refetch — and modelling
it as plain state means re-implementing all of them badly. And remember the third
outcome: a request is **loading**, **failed**, or **succeeded**. A component
modelling only "have data / no data" shows the same empty box for all three. See
`error-handling`.

## Keep updates close to the event

One action → one update → the screen follows from the new state. If you cannot say
what a click changes in a sentence, the shape is wrong, not the library.
