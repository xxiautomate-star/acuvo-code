---
name: build-with-a-framework
description: The scaffold that is known to build, and the @acuvo/ui component kit (Button, Card, Dialog, Input, Tabs) already vendored into it
when: Before npm install or any create-* command, before writing ANY button, card, dialog, input or tab, or when the answer is React/Vue/Svelte/Vite
---

# Building with a framework

You have a real machine: `npm install` works, a build step works, and its output
is what ships. This scaffold is **known to work** — measured live: install 11.9s,
`vite build` 2.0s, exit 0 both.

## ⭐ Do not re-derive the scaffold. Write `src/App.jsx` and copy the rest.

Re-deriving `package.json`, `vite.config.js`, `index.html` and `main.jsx` on
every build spends tokens on a solved problem and fails in tedious ways. **These
four are correct and free.** The part that is the request is `src/App.jsx`.

`package.json`

```json
{
  "name": "app",
  "private": true,
  "type": "module",
  "scripts": { "build": "vite build" },
  "dependencies": {
    "react": "18.3.1", "react-dom": "18.3.1",
    "@radix-ui/react-dialog": "1.1.23", "@radix-ui/react-tabs": "1.1.21", "@radix-ui/react-slot": "1.3.3"
  },
  "devDependencies": { "vite": "5.4.0", "@vitejs/plugin-react": "4.3.1" }
}
```

`vite.config.js`

```js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: { alias: { '@acuvo/ui': fileURLToPath(new URL('./src/ui', import.meta.url)) } },
});
```

`index.html`

```html
<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>App</title></head><body><div id="root"></div>
<script type="module" src="/src/main.jsx"></script></body></html>
```

`src/main.jsx`

```js
import './system.css';   // ⚠️ FIRST. It is the base layer your own CSS overrides.
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
```

### What the preview bundle resolves from npm — and nothing else

The preview and the published page bundle your tree on the server with `react`,
`react-dom` and **`motion/react`** (framer-motion 12, MIT). For animation:
`import { motion, AnimatePresence } from 'motion/react'`, then
`<motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>`. Any other npm
import is refused by name and the page goes blank — not GSAP (licence), lodash,
axios or a UI kit; `fetch` and CSS are there.

Then:

```
npm install --no-audit --no-fund && npm run build
```

## ⭐⭐ The component kit is already in the project. Do not rebuild it.

`src/ui/` is vendored into every React scaffold and aliased to `@acuvo/ui`. It is
**your** source — read it, change it — and it renders the **same `ax-` classes**
every page gets, so a component here and a hand-written element are one element.

```jsx
import { Button, Card, CardHeader, CardTitle, CardDescription, CardBody, CardFooter,
         Field, Input, Label, Tabs, TabsList, TabsTrigger, TabsContent,
         Dialog, DialogTrigger, DialogContent, DialogTitle, DialogDescription,
         DialogFooter, DialogClose } from '@acuvo/ui';

<Card>
  <CardHeader><CardTitle>Book a job</CardTitle></CardHeader>
  <CardBody>Pick a time and we will confirm it by email.</CardBody>
  <CardFooter>
    <Button>Confirm</Button>
    <Button variant="quiet">Save draft</Button>
  </CardFooter>
</Card>
```

**What the kit adds is behaviour, not styling** — the design system already does
the styling:

- `Button` — `variant` **primary | quiet | danger** (the system's three; no size
  prop, no `secondary`/`ghost`), `asChild` to style your own element.
- `Field` — generates the ids, so the label points at its input and a screen
  reader reads the error with it. Never hand-wire `htmlFor`.
- `Dialog` — real focus trap, Escape, scroll lock, background made inert.
  **Never hand-roll a modal beside this one.**
- `Tabs` — roving tabIndex and arrow keys, per the WAI-ARIA tablist contract.

⚠️ **Do not restyle it with hard-coded colours.** It is written in design tokens
and repaints itself to this build's palette. Compose instead — pass `className`.

### The three shapes worth copying

```jsx
// FORM
<Field label="Email" error={err} hint="We send the receipt here.">
  <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
</Field>

// TABLE — the kit has none on purpose: a table is markup, not behaviour.
// ⚠️ Wrap it AND let its parents shrink: a grid/flex child defaults to
// min-width:auto, so the wrapper cannot scroll and the PAGE scrolls sideways.
// Put min-width:0 on any grid/flex ancestor. <th scope>, never <td><b>, and
// tabIndex on the scroller or no keyboard can scroll it (axe:
// scrollable-region-focusable). All three measured on real builds.
<div style={{ overflowX: 'auto' }} tabIndex={0} role="region" aria-label="Jobs">
  <table className="ax-table">
    <thead><tr><th scope="col">Job</th><th scope="col">Status</th></tr></thead>
    <tbody>{jobs.map((j) => (
      <tr key={j.id}><td>{j.title}</td><td><span className="ax-badge ax-badge-ok">{j.status}</span></td></tr>
    ))}</tbody>
  </table>
</div>

// DIALOG — actions in DialogFooter, primary last. A bare button in a dialog stretches.
<Dialog>
  <DialogTrigger asChild><Button variant="danger">Delete</Button></DialogTrigger>
  <DialogContent>
    <DialogTitle>Delete this job?</DialogTitle>
    <DialogDescription>This cannot be undone.</DialogDescription>
    <DialogFooter>
      <DialogClose asChild><Button variant="quiet">Cancel</Button></DialogClose>
      <Button variant="danger" onClick={remove}>Delete</Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

`ax-grid` is already `repeat(auto-fit,minmax(16rem,1fr))` — no media queries for
a card grid.

⚠️ **It ships nothing you do not import** — the three portal rules ride in on the
barrel, and everything else is already in `system.css`.

## ⚠️⚠️ NEVER run a bare `create-*` command. It prompts, and you have no tty.

`npm create vite@latest` and `npx create-next-app` are **interactive**. Run
without every answer supplied they sit at a prompt nobody can type into, and the
first sign is a command that times out with no output — which then gets debugged
as a network problem. Supply the flags, or write the four files above:

```
npm create vite@latest app -- --template react-ts        # note the bare --
npx create-next-app@latest app --ts --app --tailwind --eslint \
    --no-src-dir --import-alias "@/*" --use-npm --yes
```


## Swapping the framework — only the plugin and the entry change

| stack | dependency | dev plugin | entry |
|---|---|---|---|
| React | `react`, `react-dom` | `@vitejs/plugin-react` | `createRoot(el).render(<App/>)` |
| Vue 3 | `vue` | `@vitejs/plugin-vue` | `createApp(App).mount('#app')` |
| Svelte | `svelte` | `@sveltejs/vite-plugin-svelte` | `new App({ target: el })` |
| vanilla | — | — | `<script type="module" src="/src/main.js">` |

⚠️ Svelte 5 replaced that entry with `mount(App, { target: el })` and stores with
runes (`$state`). Read the installed major first — 4 and 5 syntax do not mix.

## ⚠️⚠️ Tailwind: v3 and v4 need DIFFERENT files. Check which is installed FIRST.

The two are equally represented in memory and neither error names the version.
`cat node_modules/tailwindcss/package.json | grep version`, then match it:

**v3 — a JS config and three directives**

```js
// tailwind.config.js
export default { content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'], theme: { extend: {} } };
```
```css
/* src/index.css */
@tailwind base;
@tailwind components;
@tailwind utilities;
```
`postcss.config.js` → `{ plugins: { tailwindcss: {}, autoprefixer: {} } }`.

⚠️ **A missing or wrong `content` glob is why "Tailwind isn't working"** — the
classes are never generated and there is no error at all.

**v4 — one import, no JS config, and the PostCSS plugin MOVED**

```css
/* src/index.css — this ONE line replaces all three directives */
@import "tailwindcss";
@theme { --color-brand: oklch(0.72 0.19 250); }   /* config lives in CSS now */
```
- With Vite, install `@tailwindcss/vite` and add `tailwindcss()` to `plugins` —
  then delete `postcss.config.js` entirely.
- With PostCSS, the plugin is the separate package **`@tailwindcss/postcss`**.
  Leaving `tailwindcss: {}` in a v4 PostCSS config fails the build with a message
  telling you to install it — believe the message.
- There is no `content` array; v4 scans automatically.

**⚠️ Utilities v4 renamed, which look like styling bugs rather than errors:**
`shadow` → `shadow-sm` (and old `shadow-sm` → `shadow-xs`), `rounded` →
`rounded-sm`, `outline-none` → `outline-hidden`, `flex-shrink-*` → `shrink-*`,
`bg-opacity-50` → the slash syntax `bg-black/50`.

⚠️⚠️ **And the one that silently changes every design: v4's default border colour
is `currentColor`, not gray-200.** A `border` class that drew a light grey line
in v3 now draws one in the text colour. Set it explicitly rather than hunting it.

`npx @tailwindcss/upgrade` does the v3 → v4 migration properly. Do not hand-edit
a large project across the boundary.

## ⚠️ TypeScript: `vite build` does not type-check

Vite strips types; it does not check them. The `react-ts` template builds with
`tsc -b && vite build` for that reason, and `tsc -b` runs `noUnusedLocals`, so
**one unused import fails the whole build**. Run `npx tsc --noEmit` before
calling a TS project clean, and delete imports you stopped using.

## ⚠️ The four traps, each of which costs a round

**1. `"^latest"` is how a build that worked yesterday breaks today.** Every
version above is pinned on purpose. If you add a dependency, pin it too.

**2. `base: './'` is not decoration.** Without it the built `index.html` asks for
`/assets/…` from the site ROOT, and what ships is served from a path. The page
loads, the bundle 404s, and you get a blank screen with no error in the build.

**3. A hosted sandbox is shut down while you think.** Your files come back;
anything you **installed** does not (not true on someone's own computer). ⭐ You
need not know which you are on: `vite: not found` after a build that worked is
this, not your code — re-run the install.

**4. What ships is `dist/`, not your source.** `src/App.jsx` is not a web page.
So the build MUST pass: a project whose `npm run build` fails ships nothing.

## ⚠️ Every asset the built page references must exist

`dist/index.html` names its bundle and its stylesheet. If either is missing from
the tree the page still validates and renders **nothing** — the most expensive
failure available, because every other signal says the build succeeded. After
`npm run build`, check `dist/` holds what `dist/index.html` asks for.

## ⚠️ A library you can already reach beats one you install

Before `npm install`, check the vendor/toolbox listing. Heavy runtime libraries
— game engines, physics, audio — are commonly pre-served, and a `<script src>` to
them costs ~50 bytes against hundreds of kilobytes bundled. ⚠️ And in a hosted app
**a CDN `<script src>` is blocked by Content-Security-Policy**: the page loads,
the library is undefined, and the only evidence is one console line. See
`game-prototype`.

## When NOT to reach for this

A page a visitor only reads — a landing page, a brochure, a menu — is
`index.html` + `styles.css`, and a framework makes it slower to load and slower
to build for no gain. Reach for a framework when there is real state to manage:
a list that changes, a form with steps, a board you drag things around.
