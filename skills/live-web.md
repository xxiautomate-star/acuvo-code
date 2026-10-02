---
name: live-web
description: Today's internet from a generated app or its server function — AcuvoWeb.search(q) for results and AcuvoWeb.read(url) for a page's readable text — because a page can never fetch another site itself.
when: The brief needs live news, prices, a page's contents, a lookup, a summary of a URL, or anything that must be true today rather than at build time.
---

# The live web

A generated page runs under a content-security policy that names our own doors
only. **A plain `fetch('https://example.com')` from the page dies silently.**
The live internet reaches an app through one door, in two verbs:

```js
const { results } = await AcuvoWeb.search('sydney ferry timetable changes');
// results: [{ title, url, snippet }] — up to 10, default 6

const { title, text, truncated } = await AcuvoWeb.read(results[0].url);
// text: the page's readable text, up to 20,000 characters
```

Inside a server function the same two calls are `ctx.web.search(q, { limit })`
and `ctx.web.read(url)`. Pair them with `ctx.ai.chat` and the function becomes a
research agent: search, read the top two, answer with sources.

## Rules that keep it honest

- **Show the source.** Anything quoted or summarised from a page carries its
  `url` beside it, as a link. A reader deserves to check.
- **Read one or two pages, not ten.** Each read is a request against the app's
  hourly allowance (90 an hour per app, 40 per visitor). Pick from the snippets
  first; read only what the snippet does not settle.
- **Cache what every visitor would ask.** A price, a headline, a timetable: read
  it once, store it in `AcuvoData` with the time, and re-read after an interval.
  A popular page that reads on every visit spends the allowance on one number.
- **Expect refusals and say so.** `rate_limited`, `unreachable` (a private or
  dead address, a PDF, a login wall) and `search_failed` are normal. Render a
  sentence ("Could not reach that page just now"), never a blank.
- **Never read a URL a visitor typed without showing them what will be read.**
  The door refuses private addresses on every redirect hop, but a visitor can
  still point your app at a page you would not want summarised on your site.

## When NOT to use it

A named API with structured answers (weather, exchange rates, a model, a
spreadsheet) goes through `AcuvoProxy` and the connector list in
`third-party-apis`: structured beats scraped. Your own records live in
`AcuvoData`. Assets you want to keep live in `AcuvoFiles` or `AcuvoMedia`.

## A research function

```js
// functions/research.js — "what is the latest on <topic>?" with sources
module.exports = async function (args, ctx) {
  const { results } = await ctx.web.search(String(args.topic || ''), { limit: 5 });
  const pages = [];
  for (const r of results.slice(0, 2)) {
    const page = await ctx.web.read(r.url).catch(() => null);
    if (page) pages.push({ url: r.url, text: page.text.slice(0, 4000) });
  }
  const { reply } = await ctx.ai.chat(
    `Topic: ${args.topic}\n\nSources:\n${pages.map((p, i) => `[${i + 1}] ${p.url}\n${p.text}`).join('\n\n')}\n\nWrite four sentences with [n] citations.`,
    { system: 'You summarise web pages faithfully and cite by number. Say when the sources disagree.' },
  );
  return { reply, sources: pages.map((p) => p.url) };
};
```

## A real browser, from server code

Reading a page as text stops at the first form. When a task needs a click, a
search box, a "load more", a page that only renders in JavaScript or a
screenshot, a server function or an agent tool drives a real headless
Chromium on the platform:

```js
// agents/researcher.js tool, or any functions/*.js
const r = await ctx.browser.act('https://news.ycombinator.com', [
  { op: 'type', selector: 'input[name=q]', text: 'postgres' },  // fill
  { op: 'press', key: 'Enter' },                                 // submit
  { op: 'wait_for', selector: '.result' },                       // settle
  { op: 'extract', selector: '.result a' },                      // [{ text, href }]
  { op: 'screenshot' },                                          // base64 jpeg
], { timeoutS: 30, screenshot: false });
// r = { url, title, text, screenshot, results: [{ step, op, ok, text?, items?, error? }], ms }
```

Ops: `goto` (url) · `click` · `type` (selector, text) · `press` (key) · `wait`
(ms ≤ 5000) · `wait_for` · `text` · `extract` (up to 50 `{ text, href }`) ·
`screenshot` · `scroll`. Python: `ctx.browser.act(url, steps, timeoutS=30)`.

- **A step list, never a free hand.** At most 20 steps and 45 s; one failed
  step is reported in `results` and the rest still run. Plan the steps from a
  `ctx.web.read` first, then act.
- **Server-only, on purpose.** There is no `AcuvoBrowser` on the page: a
  session costs real money, so it runs from a function or an agent tool and is
  capped at 200 sessions per app per day. The page calls the function.
- **The public web only.** Loopback, private ranges, bare IPs and the
  platform's own doors are refused before a browser starts. Never type a
  secret into a page through a step; use `ctx.proxy.fetch` for a signed API.
- **Show the screenshot** when a visitor would want proof of what was seen —
  `<img src="data:image/jpeg;base64,${r.screenshot}">` — and keep the `url`.
