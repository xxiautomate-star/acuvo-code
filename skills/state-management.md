---
name: state-management
description: One source of truth, derive the rest, and knowing when local state stops being enough
when: When adding state, when two components disagree, or before reaching for a state library
---

# State

## ⚠️⚠️ One source of truth. Derive everything else.

The bug where two parts of the screen disagree is almost always two copies of
one fact.

```js
✗ let items = [...]; let itemCount = 0;   // now they can differ, and they will
✓ let items = [...]; const count = items.length;   // derived, cannot drift
```

If a value can be computed from another value, **compute it**. Store only what
cannot be derived. A cached derived value is a second source of truth wearing a
disguise.

## Where state should live

In order — take the first that works:

1. **In the component that uses it.** Most state is local and should stay there.
2. **In the nearest common parent**, when two siblings need it.
3. **In the URL**, when it should survive a refresh or be shareable — filters,
   the current tab, a search query, pagination. This is the most under-used
   option and it is free.
4. **On the server**, when it is data rather than interface state.
5. **In a global store**, only when many distant components genuinely need it.

⚠️ Reaching for a global store first makes every piece of state everyone's
business, and nothing can then be changed locally with confidence.

## Server data is not UI state

Data fetched from an API has its own concerns — loading, error, stale, refetch,
cache — and modelling it as plain state means re-implementing all of them badly.
Keep it separate from interface state (which panel is open, what is typed).

⭐ And remember the third outcome: a request is **loading**, **failed**, or
**succeeded**. A component modelling only "have data / no data" shows an empty
state during loading and after a failure, which are three different things
flattened into one. See `error-handling`.

## Never mutate what you are about to compare

```js
✗ state.items.push(x);            // same reference — a change detector sees nothing
✓ state = { ...state, items: [...state.items, x] };
```

This is the cause of "the data is right but the screen did not update".

## ⚠️ Do not put derived data in the URL or in storage

Persist the minimum: an id, not the whole object it points at; a filter, not the
filtered result. Anything stored is a copy that can go stale, and stored copies
outlive the code that wrote them — `localStorage` from a version you shipped
last year will be handed to today's code.

Validate anything read back from storage. It is untrusted input: the user can
edit it, and an old version of your app may have written it.

## Keep updates close to the event

State that changes in five places for one user action is state nobody can
follow. One action → one update → the screen follows from the new state. If you
cannot say what a click changes in a sentence, the shape is wrong, not the
library.
