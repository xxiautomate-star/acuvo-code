---
name: ship-it
description: Take a project to a live URL and PROVE it loads — clean install, build, deploy, then fetch it back
when: Asked to deploy, ship, publish, release, or go live — or a finished build that must reach a URL
---

# Ship it

Shipping is not the deploy command. **Shipping ends when you have fetched the
live URL and read what came back.** A green deploy log and a broken site are the
same log.

## ⚠️⚠️ The failure this skill exists to stop

"Deployed successfully — it's live at https://…" written without ever fetching
that URL. The four ways that sentence is false, in the order they actually
happen:

1. The build passed locally and failed on the host (different Node, missing env).
2. The build passed on the host and the page is blank (a runtime error in the
   bundle — HTTP 200, empty body).
3. The page loads and one script 404s, so nothing is interactive — still 200.
4. It works at `/` and every deep link 404s, because no SPA rewrite was configured.

**Status 200 is not proof.** Bytes you recognise are proof.

## The order, and why it is this order

### 1. Know the target before you touch anything

State these four out loud before the first command. If you cannot, ask — a
deploy to the wrong place is worse than no deploy.

- **Where** does it go (host, project name, branch)?
- **What is the build command** and **which directory** does it output?
- **Which environment variables** does it need at build time vs runtime?
- **What is the rollback command**, and who runs it?

### 2. Clean tree, clean install

`git_status` first. ⚠️ Uncommitted work means the thing you deploy is not the
thing in the repo, and nobody can reproduce it later.

Then `npm ci` — not `npm install`. `ci` installs the lockfile exactly; `install`
may silently resolve a newer transitive dependency and ship a build no one can
reproduce. (Installs are off by default here; if `npm ci` is refused, say so and
verify against the existing `node_modules` rather than pretending you did a clean
install.)

### 3. Build and typecheck locally — this is free, the deploy is not

```
npm run build          # the real build, not a dev server
npx tsc --noEmit       # or check_types — catches what the bundler skips
npm test
```

⭐ **Every production deploy on most hosts is a paid build.** Finding the error
locally costs nothing; finding it in the host's log costs a build and five
minutes. Batch your fixes and deploy once.

⚠️ **The bug that only exists on the host: case-sensitive imports.**
`import Button from './components/button'` resolves on Windows and macOS
(case-insensitive filesystems) and 404s on the Linux builder. It is the single
most common "worked locally, failed in CI" defect. Grep your imports against the
real filenames before blaming the host.

### 4. Run it locally the way production will

Do not skip this because the build passed. `npm run build` proves it compiles;
this proves it runs.

```
start_process   → "npm run start"  (or "npm run preview")
check_process   → read the announced port
call_endpoint   → GET / and read the STATUS, HEADERS and BODY
```

`call_endpoint` only reaches a port a process from **this run** announced — that
is the point, and it is why you must start the server here rather than assume one
is up. Check `/` and at least one deep route and one API route. Then
`stop_process`, because a leaked server holds the port for the next attempt.

### 5. Deploy

⚠️ **On the default surface you probably cannot run the deploy CLI.**
`npx` is limited to `vitest` and `tsc`, and an `npm run deploy` script whose body
is `vercel deploy --prod` is refused too — the script body goes through the same
allowlist. This is deliberate. Your options, in order of preference:

- **`git_push` a branch.** On a git-connected host (Vercel, Netlify, Cloudflare
  Pages, Render) the push *is* the deploy, and it produces a **preview URL** —
  which is the right thing to verify and the right thing to hand over.
  ⚠️ `git_push` refuses `main`, `master`, `production` and the remote's default
  branch. That is correct: promoting a preview to production is the human's
  decision, not a step you take because the tests passed.
- **Ask the human to run the deploy**, and give them the exact command line.
- **`--shell`, or `ACUVO_ALLOW_COMMANDS=vercel:...`**, if they choose to open it.

Never construct a way around the refusal. Say what is blocked, in one sentence,
with the command that unblocks it.

### 6. VERIFY THE DEPLOYED THING — the step that makes this a skill

`fetch_url` the live URL and read it. Then check, in this order:

- [ ] **Status is 200** — not 401 (deploy protection is on), not 404 (wrong
      output directory), not 500.
- [ ] **The body contains something you know is on the page** — a heading, a
      product name, a data attribute. Not "it returned HTML": a host's error page
      is also HTML.
- [ ] **The main script and stylesheet load.** Pull their URLs out of the HTML and
      `fetch_url` each one. A 404 here is invisible in the page fetch and it is
      what "the site loads but nothing works" always is.
- [ ] **One deep link** — `/about`, `/dashboard/1`. If it 404s while `/` works,
      the host has no SPA rewrite. That is a config fix, not a code fix.
- [ ] **The API answers**, if there is one. A 500 here usually means an env var
      that exists in `.env.local` and nowhere else.
- [ ] **Look at it.** `see_page` on the built HTML, or `read_image` on a
      screenshot. A page whose CSS 404s returns 200, contains every word you
      searched for, and is unreadable.

⚠️ If the URL is behind SSO or deploy protection you will get 401 and you cannot
verify it. **Say that plainly** — "I could not verify the live URL, it returned
401 behind deploy protection" — rather than reporting the deploy as confirmed.

### 7. Say what shipped

Commit SHA · URL · what you verified and how · what you could NOT verify · the
rollback command. Four lines. This is the record that makes the next incident
survivable.

## The defects that cause most failed deploys

| symptom | cause | fix |
|---|---|---|
| Build fails on host, passes locally | Node version differs | Pin `engines` in package.json and the host's setting |
| Blank page, 200, no errors in build | runtime error in the bundle | open it, read the console |
| Every asset 404s | wrong `base` / `basePath` for a sub-path deploy | set the base to the served path |
| Works at `/`, 404 everywhere else | no SPA rewrite | add the host's rewrite-to-index rule |
| `fetch` fails in production only | hardcoded `http://localhost:3000` | relative URLs, or an env var |
| API 500s only in production | env var missing on the host | list required vars; check each is set |
| Mixed-content blocked | an `http://` asset on an `https://` page | scheme-relative or https |
| Secret visible in the bundle | server-only value under a public prefix (`NEXT_PUBLIC_`, `VITE_`) | move it server-side and **rotate it** — it is in a public bundle now |

⭐ That last one is the expensive one. Before deploying, grep the built output
for your own secrets: `search_text` the `dist/`/`.next/` directory for the first
8 characters of any key. A key in a client bundle is public the moment it ships,
and redeploying does not un-publish it.

## Cost discipline

Each production deploy is a paid build on most hosts, and a binge of them is real
money in a pre-revenue project. **Deploy at a verified checkpoint, not after
every commit.** On a git-connected branch a push IS a build — batch commits
locally and push once per verified block. Five commits pushed together is one
build; pushed separately it is five.

## ⚠️ What this cannot do

- **It cannot decide to promote to production.** Preview URLs are yours to make
  and verify; production is the human's to authorise.
- **It cannot verify a protected deployment.** 401 means unverified. Report it.
- **It cannot check DNS, TLS issuance or CDN propagation** with any confidence —
  those settle on their own schedule and a fetch a minute after a domain change
  proves nothing either way.
- **It cannot prove the site works for a user.** It proves the bytes arrive, the
  assets resolve and the routes answer. Load, auth flows and payments need
  someone to actually use it.
- **Rollback is not automatic.** Know the command before you deploy, and put it
  in the handover.
