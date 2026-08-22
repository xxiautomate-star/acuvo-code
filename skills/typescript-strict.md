---
name: typescript-strict
description: The types that catch real bugs versus the ones that are ceremony — and why `any` costs more than it saves
when: When adding types, when tempted to write `any` or a cast, or when configuring tsconfig
---

# TypeScript

## Turn `strict` on. It is where the value is.

```json
{ "compilerOptions": { "strict": true, "noUncheckedIndexedAccess": true } }
```

Without `strict`, `null` and `undefined` are assignable to everything and the
compiler cannot catch the single most common runtime error there is. Without
`noUncheckedIndexedAccess`, `arr[10]` is typed as present when it is not.

## ⚠️⚠️ `any` does not silence one error, it disables checking downstream

```ts
✗ const data: any = await res.json();
  data.user.name          // no error here, and no error anywhere it flows
✓ const data: unknown = await res.json();
  // now you MUST narrow it — which is the check you actually wanted
```

`unknown` is the honest version of `any`. It says "we do not know yet" and
forces exactly one narrowing at the boundary, instead of letting a wrong shape
travel silently through ten functions.

The same applies to `as`. A cast is you telling the compiler to stop checking:

```ts
✗ const user = json as User;        // asserted, never verified
✓ if (!isUser(json)) throw new Error('unexpected response shape');
```

## Types that catch bugs

**Make illegal states unrepresentable.** This is the highest-value thing types
do:

```ts
✗ { loading: boolean; error?: string; data?: Invoice[] }
    // loading AND error AND data — eight states, five of them nonsense
✓ | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; data: Invoice[] }
```

Now "loading with an error" cannot be written, and every consumer is forced to
handle all three — which is the `error-handling` rule (empty ≠ failed ≠ never
ran) enforced by the compiler.

**Distinguish things that are both strings:**

```ts
type TenantId = string & { readonly __brand: 'TenantId' };
```

Passing a `UserId` where a `TenantId` belongs is a multi-tenant data leak, and
it is a compile error rather than an incident.

## Ceremony to skip

- Annotating what is obvious: `const n: number = 5`. Inference is not weaker
  typing — it is the same type, without the noise.
- An `interface` per function argument list used once.
- `Promise<void>` return annotations on every async function.
- Enums where a union of string literals reads better and needs no runtime.

⭐ Type the BOUNDARIES — function signatures, exported values, anything crossing
the network — and let inference handle the inside.

## ⚠️ Types are erased, so they are not validation

A `User` type proves nothing about what the API actually sent; it is a comment
the compiler checks *your* code against. Data arriving from outside — a
response, `localStorage`, a query param — must be checked at runtime, and only
then does its type mean anything (`security-basics`).

## `satisfies`, when you want both

```ts
const config = { port: 3000 } satisfies Config;   // checked AND still literal
```

Checks the shape without widening the type, which is what `as Config` would
have done while also disabling the check.
