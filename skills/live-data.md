---
name: live-data
description: Live data for a generated app — a shared board, a live scoreboard, a queue two people work at once — with AcuvoData.watch, which calls back with the newest snapshot and a diff whenever any record changes, and never setInterval + list.
---

# Live data — everyone sees the same thing move

`AcuvoData.watch(collection, onChange, options)` is present on every surface
next to `get`, `list`, `set`, `remove` and `clear`. It calls `onChange` with
the current records at once, then again whenever any record in the
collection is added, changed or removed — with a diff of keys — and returns a
function that stops it. Under the hood it asks the store a cheap "anything
changed?" question every few seconds and only fetches when the answer is yes;
a hidden tab does not poll.

## A live board

```html
<ul id="orders"></ul>
<script>
  const list = document.getElementById('orders');
  const stop = AcuvoData.watch('orders', (items, diff) => {
    list.innerHTML = items.map((o) => `<li data-key="${o.key}">${o.value.item} × ${o.value.qty}</li>`).join('');
    // diff = { added: ['o-42'], changed: [], removed: ['o-17'] } — use it to flash a row
    diff.added.forEach((k) => list.querySelector(`[data-key="${k}"]`)?.classList.add('new'));
  }, { every: 4000 });

  // somewhere else, any visitor:
  await AcuvoData.set('orders', 'o-42', { item: 'flat white', qty: 2 });   // every open tab sees it within `every`
  // when the view is closed:
  // stop();
</script>
```

Options: `every` 2 000–60 000 ms (default 5 000), `limit` up to 500 records
(default 100). `AcuvoData.private.watch` is identical for the signed-in
person's own records.

## The rules

- Render from `items` every time; never patch the DOM from `diff` alone.
  The diff is for effects (a flash, a sound), the snapshot is the truth.
- One `watch` per collection per view, and call `stop()` when the view is
  torn down. Ten watches on one page is ten pollers.
- Latency is `every`, not zero. Say "updates every few seconds" in the UI
  rather than promising instant.
- Do not build `setInterval(() => AcuvoData.list(...))`: `watch` does the
  same thing with the cheap question in front of it, and the diff is free.

## History: what a record used to be

`const versions = await AcuvoData.history('orders', id)` → `[{ at, op: 'set' | 'remove', value }]`,
newest first, up to 20 (30 days). Every overwrite and delete keeps the previous value on the
platform, nothing to write. Undo is a write of the old value:
`AcuvoData.set('orders', id, versions[0].value)`.
`AcuvoData.private.history` for a person's own rows; `ctx.data.history` in a function.

## Search over the store

`AcuvoData.search(collection, text)` returns records whose text contains
`text` anywhere (case-insensitive, newest first, up to 100). Put it behind a
search box; do not list everything and filter in the page.

```js
const box = document.querySelector('#search');
let timer;
box.addEventListener('input', () => {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const { items } = box.value.trim()
      ? await AcuvoData.search('contacts', box.value.trim(), { limit: 50 })
      : await AcuvoData.list('contacts');
    render(items);
  }, 250);
});
```

`AcuvoData.private.search` is the same over the signed-in person's own
records. Matching is substring, not ranking; say "contains" in the UI. For
typo-tolerant ranking over records already loaded, the shelf has Fuse (tag in
`vendor-shelf`):

- **Fuse** is typo-tolerant search over objects. Name the `keys`, and lower
  `threshold` toward 0.3 — the 0.6 default is very loose.
