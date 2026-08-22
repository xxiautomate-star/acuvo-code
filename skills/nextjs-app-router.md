---
name: nextjs-app-router
description: Next.js App Router — server vs client components, data loading, the mistakes that cost hours
when: Working in a Next.js project, or any app/ directory with page.tsx
---

# Next.js App Router

## The rule everything else follows

**Server components fetch. Client components render.** A component is a server
component unless it says `'use client'`.

Put every read in the page (server), pass results down as props. A child that
fetches forms its own opinion about a failure the page already has one sentence
for — and its failure renders as an empty state, which is indistinguishable from
"nothing happened".

```tsx
// page.tsx — server. Reads, decides, passes down.
export default async function Page({ params }: { params: { id: string } }) {
  const { rows, error } = await read(params.id);
  if (error) return <Unreadable why={error} />;   // ONE place says "broken"
  return <Detail rows={rows} />;                   // the child only renders
}
```

⚠️ `'use client'` is contagious downward. A client component's children are all
client. Push it to the leaf that actually needs interactivity — a single
`<LikeButton />`, not the page.

## What forces 'use client'

`useState` · `useEffect` · `useRef` · event handlers (`onClick`) · browser APIs
(`window`, `localStorage`, `IntersectionObserver`). Nothing else.

## Params are async in Next 15+

```tsx
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
}
```
⚠️ Getting this wrong gives a confusing runtime error, not a type error.

## Caching, which is where the hours go

- `export const dynamic = 'force-dynamic'` when the page must read fresh data
  every request. Without it you can ship a dashboard that shows build-time data
  forever and looks merely "stale" rather than broken.
- `revalidate = N` for periodic refresh.
- Mutations use a server action or route handler, then `revalidatePath()`.

## Common failures, in order of how often they bite

1. **A server component imported into a client component** — everything below
   becomes client and the fetch breaks. Pass it as `children` instead.
2. **`useSearchParams` without `<Suspense>`** — build error at the very end.
3. **Env vars.** Only `NEXT_PUBLIC_*` reach the browser. A secret read in a
   client component is `undefined`, not an error.
4. **Hydration mismatch** — `Date.now()`, `Math.random()` or `localStorage` in
   render. Move to `useEffect`.
5. **Images** — `next/image` needs `width`/`height` or `fill` + a positioned
   parent.

## Route handlers

```ts
export async function POST(req: Request) {
  const body = await req.json();          // throws on bad JSON — catch it
  return Response.json({ ok: true }, { status: 200 });
}
```
Always validate the body. Never trust `body.tenantId` from the client to decide
what data to return — derive it from the authenticated session.
