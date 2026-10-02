---
name: check-the-site-you-built
description: Open the page in a real browser, read the console, shrink it to a phone, fix what you find — before showing anyone
when: After generating or editing any website, landing page, app UI or HTML — ALWAYS before saying done
---

# Check the site you built

You have a browser. Use it before you hand anything over.

## ⭐ If `playtest` is in your tool list, that is the whole check — use it

One call. It opens the page, presses what you tell it to, and returns a short
ordered list of what is broken. Do not drive the browser by hand when it is
offered: the manual loop below costs a round per action and puts a full
accessibility tree in the transcript each time, and the transcript is re-sent on
every round after that.

```
playtest({
  url: "http://localhost:3000",          // or "dist/index.html"
  steps: [{ do: "click", target: "Get started" }],
  expect: ["Welcome"],
  phone: true
})
```

⚠️ **In the Acuvo builder the first argument is `page`, not `url`** — that surface
has a workspace and no server, so it is `playtest({ page: "index.html", steps: […],
expect: […] })`. Everything else is identical. There, `check_page` LOOKS (console
errors, broken assets, one drive it picks for itself) and `playtest` is the one you
steer — use both, and never treat "nothing could be driven" as a pass.

⭐ **Always give it `steps` and `expect`.** With neither, it can only tell you
the page loaded and the console is quiet — which is a screenshot with extra
steps. `steps` is how the button that is wired to nothing gets found; `expect`
is how you learn the thing you built never rendered.

Read `problems` top-down and fix the first one — it usually explains the rest.
Then run it again. ⚠️ And read `summary`: if it names anything under **NOT
checked**, you did not verify that part and must not say you did.

🎮 **For a canvas game, press the real keys** (`{ do: "press", text: "ArrowRight" }`)
and read `frame`: `moved: true` means the picture changed after your input; a
problem saying the canvas *never changed* means it did not start or does not
animate. ⚠️ Text PAINTED on the canvas (a score, "Game Over") is not page text —
`expect` cannot see it and will report it missing. Put in `expect` only what is
real DOM text, and let `moved` prove the game runs.

🎮 **Then lose on purpose and restart**, in the same call: `steps: [{ do: "press",
text: "Space" }, { do: "wait", text: "Game over" }, { do: "press", text: "Space" }]`,
`expect: ["Playing"]` — the `#status` line from `game-prototype` C4 is what makes
that text real. Without `playtest`, after pressing start run this in the page:

```js
const c = document.querySelector('canvas'), r = c.getBoundingClientRect();
[r.width, r.height, c.width, c.height,   // every one ≥ 100; a 0 or 2 is the bug
 document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === c]  // true
```
`false` means an overlay still covers the canvas. And every `.js` you wrote must
be in a `<script src>` that loads — no 404.
Then `phone: true`: a TAP must start it, and a tap on a cell must change *that*
cell — `e.offsetX` maths lands elsewhere on a scaled canvas.

If `playtest` is NOT in your tool list, the manual loop below is the fallback.

## ⚠️ The rule

**Never present a generated page you have not opened.**

Not "it should work". Not "the HTML is valid". Open it, look at it, read what the
browser says about it, and fix what you find. A page that renders unstyled
because one stylesheet path had a typo is indistinguishable, to the person
looking at it, from a product that cannot design.

## The loop, in order

1. **Open it.** `browser_navigate` to a `http://localhost` URL. ⚠️ `@playwright/mcp`
   REFUSES `file://` by default — serve the folder, or use the `browser`
   (chrome-devtools) server, which opens workspace files directly.
2. **Read the console.** `browser_console_messages` with `level: "error"`. A single
   uncaught `TypeError` means half the page's behaviour is dead while the layout
   still looks perfect — this is the failure most likely to survive a glance.
3. **Look at the structure.** `browser_snapshot` returns the accessibility tree.
   ⭐ Prefer it to a screenshot: it is far cheaper in tokens and it tells you
   whether a control is actually a button rather than whether it is pretty.
4. **Press the main thing.** If you built a form, fill it and submit it. If you
   built a filter, filter something. The bench-measured difference between a
   demo that lands and one that dies is whether the primary action works.
   ⚠️ **Then open one row, edit it, save, reload.** Split into files, a router
   and a screen can disagree on a shape — measured: the router passed `{ id }`,
   the screen read it as the id, and every contact page said "not found" with a
   clean console.
5. **Shrink it to a phone.** `browser_resize` to 390×844 and snapshot again.
   Most generated layouts break here and nowhere else. ⚠️ **Then do it again at
   360.** 390 is an iPhone; 360 is the common Android and the bar
   `ui-components` already states. Measured across the audited corpus, two pages
   were clean at 390 and scrolled sideways at 375 — a page that only passes at
   the widest phone has not passed.
6. **Fix what you found, then GO BACK TO STEP 1.** A fix you have not re-checked
   is a change, not a fix.

### ⚠️⚠️ Steps 4 and 5 are in that order for a reason — CHECK IT WITH DATA IN IT

An app at first paint is **empty**: no rows, no cards, no grid, no table, and a
primary button that is disabled until something is typed. Loading it and
resizing it measures the empty state and nothing else — which is the one state
that was never going to break.

⭐ **So add two or three records the way a user would, and only then read the
console, tab through it, and shrink it to a phone.** If it persists, reload and
look again: half of what breaks only exists on the second visit.

⚠️ **Measured, and it is the whole difference between finding the bug and not.**
A shipped habit tracker was clean at phone width with zero habits and scrolled
sideways by 205px with three, because the seven-day grid — the entire point of
the app — does not exist until a habit does. Every width-dependent defect lives
in the populated state: the grid with too many columns, the row of buttons that
wraps, the table wider than the phone, the name long enough to push the layout
open. None of them is reachable from a fresh load.

## ⚠️ What counts as a finding

- an error in the console — always
- a control that does nothing when pressed
- an image, stylesheet or script that 404s
- text overflowing, overlapping, or clipped at 390px wide — **with rows in it**,
  not on the empty page
- a form that submits and gives the user no response at all
- ⚠️ **a form that says "Thanks" and stored nothing** — 21 of 61 shipped forms do
  exactly this. Submit it, then reload and look for what you typed. If it is not
  there, the page thanked somebody for a message that no longer exists
- a count, total or state label that still reads what it read before you acted

## ⚠️⚠️ The half of a website that is not on the screen

A page can look perfect in the browser and still not be a website. None of the
following is visible in a screenshot, none of it will ever appear in `problems`,
and every one of them is what someone notices first when the link gets shared.

**The document head — check it on every page you ship:**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Booking — Northside Plumbing</title>
  <meta name="description" content="One sentence a human would read in a search result.">
  <link rel="icon" href="favicon.svg">
  <meta property="og:title" content="Booking — Northside Plumbing">
  <meta property="og:description" content="…">
  <meta property="og:image" content="https://…/share.png">   <!-- absolute URL, 1200×630 -->
  <meta name="twitter:card" content="summary_large_image">
</head>
```

- ⚠️ **`<title>` is the single most-seen string you write** — browser tab, search
  result, bookmark, shared link. `Document`, `index`, `My Site` and `React App`
  are all shipped defaults, and all of them read as unfinished. Format it
  `Page — Site`, most specific first.
- ⚠️ **Without the viewport meta, a phone renders the desktop layout zoomed
  out.** Your responsive CSS is present, correct, and never applied. This is the
  most common cause of "it looks fine to me but terrible on his phone".
- **`lang` on `<html>`** decides screen-reader pronunciation and browser
  translation offers. One attribute.
- **`og:image` must be an absolute URL.** A relative one silently produces a
  bare grey link preview everywhere the site is pasted.
- **A missing favicon is a 404 on every page load** and a blank square in a row
  of bookmarks. An inline SVG with the initial costs nothing.
- **One `<h1>` per page**, and the heading levels descend without skipping.
  Headings are the document's outline, not a size picker — reach for CSS when
  you want big text.

**And the pages that only exist when something goes wrong:** a 404 that carries
the site's own navigation and a link home, rather than the host's default. If
the site is multi-page, click a link you have deliberately broken and look at
what a visitor would get.

⭐ **Verify it the way it will be experienced**, not by reading your own markup:
view source on the shipped page, and paste the URL into a chat to see the
preview card render. A share card is a feature; it is just one nobody tests.

## ⭐ What does NOT count

Taste. If it works, is readable and is not broken at phone width, ship it. Do not
loop on making it prettier — the user asked for a thing that works, and you
cannot tell from an accessibility tree whether a shade of blue is right.

## If the browser is not available

Say so, once, plainly: *"I could not open it — the browser tool is not configured
here, so I have not verified this renders."* Then hand it over anyway.

⚠️ **Do not silently skip the check and describe the page as if you had seen
it.** An unverified page presented as verified is worse than an unverified page
presented honestly, because it spends trust that has to be repaid later.

To make the browser available in the CLI: `acuvo mcp add playwright`. ⚠️ That is a
STDIO server and it is a terminal-only answer — the builder runs serverless and can
only reach HTTP MCP servers, so there the browser is the hosted one behind
`playtest`/`check_page` and there is nothing for you to install.

## Why this is a skill and not a suggestion

⚠️ We have shipped the opposite mistake repeatedly: a capability wired,
documented, offered — and never used, because nothing told the agent it MUST.
Offering a browser tool changes nothing on its own. **An option is not a
default.** This file is the instruction that makes it one.
