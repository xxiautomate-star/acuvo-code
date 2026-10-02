---
name: nextjs-app-router
description: Next.js App Router — server vs client, the async-API break in 15, the caching flip, and what changed again in 16
when: Working in a Next.js project, or any app/ directory with page.tsx
---

# Next.js App Router

## ⚠️⚠️ READ THE INSTALLED MAJOR BEFORE YOU WRITE A LINE

`grep '"next"' package.json`. Next 14, 15 and 16 differ in ways that produce
**runtime errors and silent wrong data, not type errors**, and all three versions
are equally represented in a model's memory. The deltas are below; getting the
version wrong costs a round every time.

## The rule everything else follows

**Server components fetch. Client components render.** A component is a server
component unless it says `'use client'`.

Put every read in the page (server), pass results down as props. A child that
fetches forms its own opinion about a failure the page already has one sentence
for — and its failure renders as an empty state, which is indistinguishable from
"nothing happened".

```tsx
// page.tsx — server. Reads, decides, passes down.
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;                     // ⚠️ await — see below
  const { rows, error } = await read(id);
  if (error) return <Unreadable why={error} />;    // ONE place says "broken"
  return <Detail rows={rows} />;                    // the child only renders
}
```

⚠️ `'use client'` is contagious downward. A client component's children are all
client. Push it to the leaf that actually needs interactivity — a single
`<LikeButton />`, not the page.

**What forces `'use client'`:** `useState` · `useEffect` · `useRef` · event
handlers (`onClick`) · browser APIs (`window`, `localStorage`,
`IntersectionObserver`). Nothing else.

## ⚠️⚠️ Next 15 made the request APIs ASYNC. Next 16 removed the sync fallback.

`params`, `searchParams`, `cookies()`, `headers()` and `draftMode()` all return
Promises from 15 onward:

```tsx
const { id } = await params;
const { q } = await searchParams;
const store = await cookies();            // then store.get('session')
const h = await headers();
```

On 15 the old sync access still worked with a deprecation warning, so code that
looked fine there **throws on 16**. On 14 the opposite: awaiting a plain object
is harmless, so writing the async form is the safe default either way.

⚠️ Route handlers take the same treatment:
`export async function GET(req: Request, { params }: { params: Promise<{ id: string }> })`.

## ⚠️⚠️ The caching default FLIPPED in 15, and stale data has no error message

| | 14 | 15 and later |
|---|---|---|
| `fetch()` | cached by default | **not cached** by default |
| `GET` route handlers | cached by default | **not cached** by default |
| client router cache | reused page segments | not reused (staleTime 0) |

So a dashboard that showed build-time data forever on 14 now refetches, and a
list you *wanted* cached on 15 quietly hits the origin on every request. Neither
is an error; both are wrong. State the intent explicitly:

- `fetch(url, { cache: 'force-cache' })` to cache, `{ next: { revalidate: 60 } }`
  to cache with a TTL, `{ cache: 'no-store' }` to never.
- `export const dynamic = 'force-dynamic'` on a page that must read fresh data
  every request; `export const revalidate = 60` for periodic.
- Mutations use a server action or route handler, then `revalidatePath()` /
  `revalidateTag()` — a write with neither leaves the old page cached.

## Next 16 specifics

- **Turbopack is the default bundler** for `next dev` AND `next build`. A custom
  webpack config in `next.config.js` is no longer being read unless you opt out
  with `next build --webpack`. A build that "ignores my loader" is this.
- **`next lint` was removed** — call ESLint (or Biome) directly. A `package.json`
  script that still calls it fails.
- Node 20.9+ is required.

## Server actions

```tsx
'use server';                                  // whole file, or first line of fn
export async function rename(formData: FormData) {
  const session = await auth();                // ⚠️ derive identity HERE
  const name = String(formData.get('name') ?? '').trim();
  if (!name) return { error: 'Name is required' };
  await db.rename(session.tenantId, name);     // never formData.get('tenantId')
  revalidatePath('/things');
}
```

⚠️⚠️ **A server action is a public HTTP endpoint.** It can be invoked with any
arguments by anyone who has the page. Validate every argument and derive the
tenant/user from the session — a `tenantId` passed from the client is a
multi-tenant data leak with a friendly-looking API.

## The special files, and the one that must be a client component

`layout.tsx` · `page.tsx` · `loading.tsx` · `not-found.tsx` are server by default.

⚠️ **`error.tsx` MUST start with `'use client'`** — it takes `{ error, reset }`
and cannot work as a server component. Omitting it is a build error whose text
does not obviously say "add use client". And an `error.tsx` only catches errors
*below* it, never in its own `layout.tsx`; a layout that throws needs
`global-error.tsx`.

## Common failures, in order of how often they bite

1. **A server component imported into a client component** — everything below
   becomes client and the fetch breaks. Pass it as `children` instead.
2. **`useSearchParams` without `<Suspense>`** — a build error at the very end of
   a long build, on a page that dev-served perfectly.
3. **Env vars.** Only `NEXT_PUBLIC_*` reach the browser. A secret read in a
   client component is `undefined`, not an error.
4. **Hydration mismatch** — `Date.now()`, `Math.random()`, `localStorage` or a
   locale-dependent format in render. Move it to `useEffect`.
5. **Images** — `next/image` needs `width`/`height`, or `fill` plus a positioned
   parent. A remote `src` also needs its host in `images.remotePatterns` or it
   throws at request time, having built fine.
6. **Metadata in a client component does nothing.** `export const metadata` and
   `generateMetadata` are server-only and are silently ignored under
   `'use client'` — the tab keeps whatever the layout set.

## Route handlers

```ts
export async function POST(req: Request) {
  let body: unknown;
  try { body = await req.json(); } catch { return Response.json({ error: 'bad json' }, { status: 400 }); }
  return Response.json({ ok: true });
}
```

`await req.json()` throws on an empty or malformed body, which is what a health
check or a preflight sends. Validate the parsed body, and derive identity from
the session — never from the body.
