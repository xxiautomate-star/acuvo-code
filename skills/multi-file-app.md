---
name: multi-file-app
description: Splitting an app into real files — the layout, ES modules, one data layer, a router, and a boot that fails loudly
when: The app has more than one screen, more than ~300 lines of script, or you are about to put everything in one index.html
triggers: multi file, multiple files, split into files, file structure, project structure, architecture, modules, es modules, folder layout, big app, large app, scaffold, how to organise the code
version: 2
applies-to: both
---

# A multi-file app

Most shipped artifacts hold exactly ONE source file. That is why they are hard
to edit, why a fix in one place breaks another, and why nothing can be worked on
in parallel. An app with more than one screen is a project, not a page.

## The layout — plain HTML + ES modules (no build step)

```
index.html          shell: <main id="app">, the nav, ONE <script type="module" src="js/main.js">
css/app.css         tokens first (:root custom properties), then components
js/main.js          boot: wire the router, load data, render the first screen
js/store.js         the ONLY file that talks to AcuvoData — every read and write goes here
js/router.js        hash router: #/list, #/item/42, #/settings
js/views/*.js       one file per screen, each exports render(el, params)
js/ui.js            shared helpers: $(), mustGet(), toast(), formatters
```

⭐ **A view never calls `AcuvoData` directly.** It calls `store.js`. When the
record shape changes you edit one file, and the "13% of shipped apps reference
an element or field that does not exist" failure has one place to live instead
of twelve.

⚠️ **`<script type="module">` has its own scope.** A function defined in a
module is NOT on `window`, so `onclick="save()"` in the HTML throws
`save is not defined`. Attach listeners in the view with `addEventListener`.

⚠️ **Relative imports need the extension**: `import { list } from './store.js'`
— `'./store'` 404s in a browser.

## ⛔ A browser file is never run under Node

`node js/main.js` on a file that touches `document` either throws or — worse —
waits on a promise that never settles and is killed after 30 seconds. A build
once spent five 30-second runs doing exactly this and ran out of room. To check
a browser app: `check_project` / `playtest` / open it. To test LOGIC under Node,
keep it in a pure module (no `document`, no `window`) and import that.

## The router — seven lines, and the back button works

```js
// js/router.js
const routes = [];
export function route(pattern, view) { routes.push({ re: new RegExp('^' + pattern.replace(/:\w+/g, '([^/]+)') + '$'), view }); }
export function start(el) {
  const go = () => {
    const path = location.hash.slice(1) || '/';
    for (const r of routes) { const m = r.re.exec(path); if (m) return r.view(el, m.slice(1)); }
    el.textContent = 'Not found';
  };
  addEventListener('hashchange', go); go();
}
```

## Boot that fails loudly — `mustGet`

A missing element is the commonest dead app: `getElementById` returns `null`
and the first `.addEventListener` throws, so nothing on the page works and
nothing says why. Look elements up through one helper that names what is
missing.

```js
// @selftest — mustGet names the missing element instead of throwing "cannot read properties of null"
function mustGet(root, id) {
  const el = root.getElementById(id);
  if (!el) throw new Error(`#${id} is missing from the page — the view and the HTML disagree`);
  return el;
}
const fakeDoc = { getElementById: (id) => (id === 'save' ? { id } : null) };
assert.equal(mustGet(fakeDoc, 'save').id, 'save');
assert.throws(() => mustGet(fakeDoc, 'totl'), /#totl is missing/);
```

## The route table, tested without a browser

```js
// @selftest — the router's pattern matching is pure, so it is testable under Node
function compile(pattern) { return new RegExp('^' + pattern.replace(/:\w+/g, '([^/]+)') + '$'); }
function match(routes, path) {
  for (const [pattern, name] of routes) { const m = compile(pattern).exec(path); if (m) return [name, m.slice(1)]; }
  return null;
}
const table = [['/', 'home'], ['/item/:id', 'item'], ['/item/:id/edit', 'edit']];
assert.deepEqual(match(table, '/'), ['home', []]);
assert.deepEqual(match(table, '/item/42'), ['item', ['42']]);
assert.deepEqual(match(table, '/item/42/edit'), ['edit', ['42']]);
assert.equal(match(table, '/nope'), null);
```

## A view, the shape every screen takes

```js
// js/views/list.js
import { listItems } from '../store.js';
export async function render(el) {
  el.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const items = await listItems();
    el.innerHTML = items.length ? items.map((i) => `<a href="#/item/${i.key}">${escapeHtml(i.value.title)}</a>`).join('') : '<p>Nothing yet — add the first one.</p>';
  } catch (err) {
    el.innerHTML = `<p role="alert">Could not load: ${escapeHtml(err.message)}</p>`;
  }
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
```

Three states every time: loading, empty, error. A view that only has "loaded"
is a blank rectangle whenever the network is slow.

## When to use React instead

`scaffold_app` writes a pinned React + Vite project and you supply `src/App.jsx`.
Choose it when state is deeply shared between many components (a board, an
editor, a spreadsheet). For forms, lists, dashboards and CRUD, the module layout
above is smaller, has no build step, and is easier for the next edit to read.

## Before you finish

- Every `import` path ends in `.js` and the file exists.
- Every id a view looks up exists in the HTML it renders (`mustGet` proves it).
- Reload on a deep link (`#/item/42`) — it must render that item, not the home.
- `store.js` is the only file containing `AcuvoData`.
