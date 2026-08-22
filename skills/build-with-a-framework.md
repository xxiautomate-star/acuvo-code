---
name: build-with-a-framework
description: The scaffold that is known to build — pinned, base-relative, and the four traps that waste a round each
when: Before running npm install, or whenever the answer is React/Vue/Svelte/Tailwind rather than hand-written vanilla
---

# Building with a framework

You have a real machine. `npm install` works, a build step works, and the output
of that build is what ships. This is the scaffold that is **known to work** —
measured on a live machine: install 11.9s, `vite build` 2.0s, exit 0 both.

## ⭐ Do not re-derive the scaffold. Write `src/App.jsx` and copy the rest.

Asking a model to emit `package.json`, `vite.config.js`, `index.html` and
`main.jsx` correctly on every build spends tokens re-deriving a solved problem
and fails in ways that are tedious to repair. **These four files are correct,
and they are free.** The part that is actually the request is `src/App.jsx`.

`package.json`

```json
{
  "name": "app",
  "private": true,
  "type": "module",
  "scripts": { "build": "vite build" },
  "dependencies": { "react": "18.3.1", "react-dom": "18.3.1" },
  "devDependencies": { "vite": "5.4.0", "@vitejs/plugin-react": "4.3.1" }
}
```

`vite.config.js`

```js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], base: './' });
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
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
createRoot(document.getElementById('root')).render(<App />);
```

Then:

```
npm install --no-audit --no-fund && npm run build
```

## ⚠️ The four traps, each of which costs a round

**1. `"^latest"` is how a build that worked yesterday breaks today.** Every
version above is pinned on purpose. If you add a dependency, pin it too.

**2. `base: './'` is not decoration.** Without it the built `index.html` asks for
`/assets/…` from the site ROOT, and what ships is served from a path. The page
loads, the bundle 404s, and you get a blank screen with no error in the build.

**3. If your machine is a hosted sandbox, it is shut down while you think.**
That is true of Acuvo's builder, where the box stops billing for idle time and a
fresh one starts for your next command: **your files come back; anything you
INSTALLED does not.** It is NOT true when you are running on someone's own
computer, where nothing disappears between commands.

⭐ You do not have to know which you are on. If a build suddenly says
`vite: not found` after it worked, that is this and not your code — re-run the
install. Where it applies, the command output says so in its first line.

**4. What ships is `dist/`, not your source.** `src/App.jsx` is not a web page.
So the build MUST pass: a project whose `npm run build` fails ships nothing at
all, and you will be asked to fix it before you can finish.

## ⚠️ Every asset the built page references must exist

The built `dist/index.html` names its bundle and its stylesheet. If one of them
is missing from the tree, the page still validates and renders **nothing** —
which is the most expensive failure available, because every other signal says
the build succeeded. After `npm run build`, check that `dist/` contains what
`dist/index.html` asks for.

## When NOT to reach for this

A page a visitor only reads — a landing page, a brochure, a menu — is
`index.html` + `styles.css`, and a framework makes it slower to load and slower
to build for no gain. Reach for a framework when there is real state to manage:
a list that changes, a form with steps, a board you drag things around.
