---
name: design-foundation
description: The Tailwind 3 + shadcn/ui template — the block shelf (hero, pricing, dashboard shell, auth, data table, empty state, settings) and its 11 themes
when: A React project whose ACUVO.md says "Design foundation", laying out any screen or section
triggers: shadcn, shadcn ui, tailwind, tailwind css, block shelf, design foundation, ui blocks, pricing block, hero block, dashboard shell, data table block, switch theme
version: 1
applies-to: builder
---

# The design foundation

The project already holds Tailwind 3, shadcn/ui on Radix, a block shelf and
eleven themes. **Compose; do not invent.** A section that a block covers is
written by importing the block, never by hand.

| layer | import | what |
|---|---|---|
| theme | `src/main.tsx` → `import './themes/<id>.css'` | every colour, font, radius, shadow, easing |
| components | `@/components/ui/<name>` | button, card, dialog, input, label, tabs, table, sheet, sonner, dropdown-menu, badge |
| blocks | `@/blocks` | the sections below |

## Classes — the theme's, never yours

`bg-background text-foreground` · `bg-card` · `bg-primary text-primary-foreground`
(the BRAND colour) · `bg-accent` (a hover wash, shadcn's meaning) ·
`text-muted-foreground` · `border-border` · `ring-ring` · `text-destructive` ·
`text-success` · `font-display` (headings) · `text-step--1 … text-step-3` (the
type scale) · `rounded-md` / `rounded-lg` (the theme's radius) · `shadow` (the
theme's one elevation — `none` on editorial, stark, terminal). Opacity works:
`bg-primary/10`. ⚠️ No `bg-[#…]`, no `text-blue-600`: a literal colour does not
follow the theme and is the tell of a template.

## The blocks

```tsx
import { Hero, FeatureGrid, Pricing, DashboardShell, StatGrid, AuthCard, DataTable, EmptyState, SettingsPanel } from '@/blocks'
import { Toaster, toast } from '@/components/ui/sonner'   // mount <Toaster /> once in App
```

**Hero** — split when `media` is given, centred otherwise. The page's one h1.
```tsx
<Hero eyebrow="Gold Coast · all year" title="Catch your first wave."
  subtitle="Small groups, real coaches, boards included."
  primary={{ label: 'Book a lesson', onClick: () => setScreen('book') }}
  secondary={{ label: 'How it works', href: '#how' }}
  media={<img src={photo} alt="A surfer on a green wave" className="aspect-[4/3] w-full object-cover" />}
  proof={['4.9★ from 2,100 surfers', 'Boards + wetsuits included']} />
```

**FeatureGrid** — 3 or 6 items (4 or 5 leave an orphan).
`<FeatureGrid eyebrow="Why us" title="…" features={[{ title, body, icon? }]} />`

**Pricing** — exactly one `featured`.
`<Pricing title="Simple pricing" plans={[{ name: 'Solo', price: '$19', period: 'mo', features: ['…'], cta: 'Start', featured: true, onSelect }]} />`

**DashboardShell** — sidebar ≥ md, a Sheet below it; screens go in `children`.
```tsx
<DashboardShell brand="Ledger" title="Customers"
  nav={[{ label: 'Overview', active: screen === 'overview', onClick: () => setScreen('overview') }, …]}
  actions={<Button size="sm">New customer</Button>}>
  <StatGrid stats={[{ label: 'Revenue', value: '$48,210', delta: '12%', trend: 'up' }]} />
  …
</DashboardShell>
```

**DataTable** — search, sortable columns, pagination, row menu, real empty state.
Rows need a stable `id`.
```tsx
<DataTable rows={jobs} columns={[
  { key: 'customer', header: 'Customer', sortable: true },
  { key: 'status', header: 'Status', render: (r) => <Badge variant={r.status === 'Paid' ? 'success' : 'secondary'}>{r.status}</Badge> },
  { key: 'total', header: 'Total', align: 'right', sortable: true },
]} actions={[{ label: 'Edit', onSelect: edit }, { label: 'Delete', onSelect: remove, destructive: true }]}
  toolbar={<Button size="sm">Add job</Button>} />
```

**AuthCard** — `mode="sign-in" | "sign-up"`, `onSubmit` returns a promise; throw
an `Error` to show its message. Wire it to `AcuvoAuth`.

**EmptyState** — every list's zero state: why it is empty + the one action.
`<EmptyState title="No bookings yet" body="…" action={<Button>Add a booking</Button>} />`

**SettingsPanel** — tabs of fields, a save that toasts.
`<SettingsPanel sections={[{ id: 'profile', label: 'Profile', fields: [{ name: 'name', label: 'Business name' }] }]} onSave={save} />`

## Components the blocks do not cover

Dialog (`Dialog > DialogTrigger asChild + DialogContent > DialogHeader/Title/Description/Footer`),
Sheet (`side="right"` drawer), Tabs, Table, DropdownMenu (`DropdownMenuItem variant="destructive"`),
Input + Label (`htmlFor` = `id`), Badge (`default | secondary | success | warning | destructive | outline`),
Button (`default | outline | secondary | ghost | destructive | link`, sizes `sm | lg | icon`,
`asChild` to wrap an `<a>`).

## Themes

editorial · console · console-light · soft · soft-dark · stark · midnight ·
terminal · lilac · brutal · boutique. ACUVO.md names the one this brief got;
switch only when the owner asks for a different feel — one import line, nothing
else changes. Never add a second theme file or redefine `--accent`.

## Before you finish

`npm run build` exits 0. Every list has its EmptyState. One `bg-primary` action
per view. No literal colours in `className`. Licences: shadcn/ui (MIT, notice in
`THIRD_PARTY_NOTICES.md` — keep it), Radix (MIT), cva (Apache-2.0); add no
package whose licence is not MIT or Apache-2.0.
