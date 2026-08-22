---
name: auth-and-sessions
description: Sessions, refresh, and the re-signin bug — why a user gets logged out mid-click and how to stop it
when: When building sign-in, protecting a route, or debugging a user being logged out unexpectedly
---

# Auth and sessions

## ⚠️⚠️ The re-signin bug, which is nearly always the same two causes

A user is signed in, clicks something, and lands on the login page. Almost every
time it is one of these:

**1. A failed refresh treated as "signed out".**

```js
✗ const { user } = await getUser();
  if (!user) redirect('/login');      // a 500 from the auth server looks identical to a real logout
```

`getUser()` can fail three ways and they are not the same:

| what happened | correct response |
|---|---|
| valid session | continue |
| **401 / 403** — the token is genuinely bad | sign out |
| **network error, 5xx, timeout** | **do NOT sign out** — retry, or fail the request |

Destroying a session because the auth service had a bad second is the bug. Read
the status, not just the absence of a user. This is `error-handling`'s rule —
*empty ≠ unreadable* — applied to identity.

**2. Two things refreshing the same token at once.** Concurrent refreshes race;
one rotates the token, the other presents the now-stale one and is rejected.
Single-flight the refresh: one in-flight promise that every caller awaits.

## Sessions expire. Plan the moment.

- Short-lived access token + long-lived refresh token is the standard shape.
- Refresh **before** expiry, not on the 401 — a refresh triggered by a failure
  means the user already saw an error.
- When the session really is over, say so and **preserve what they were doing**.
  Sending someone to a bare login screen after they typed a long form is the
  part that makes people angry, not the logout itself.

## ⚠️⚠️ The client cannot be the gate

Hiding a button is presentation. The check that matters runs on the server, on
every request, for every resource — because the client is a program the user
controls.

```js
✗ if (user.role === 'admin') showDeleteButton();   // and the endpoint checks nothing
✓ the endpoint verifies the caller may delete THIS row, every time
```

Route protection in a framework is convenience. An unprotected API under a
protected page is still an unprotected API.

## Passwords, if you must hold them

Never store them recoverable. `bcrypt`, `scrypt` or `argon2` — never a plain
hash, never your own scheme. Compare with a constant-time function.

Better: do not hold them. An OAuth provider or a magic link removes the entire
class of problem, including the breach you would otherwise have to disclose.

## Cookies

`HttpOnly` (JavaScript cannot read it, so XSS cannot steal it), `Secure`,
`SameSite=Lax` as the default. A token in `localStorage` is readable by every
script on the page, including one that arrived through a dependency.

## ⚠️ Multi-tenant: the row belongs to a tenant, not to a user

Every query filters by tenant, and the filter comes from the SESSION, never from
a parameter the caller supplied. `?tenant=other-company` is the whole attack.
See `supabase-multitenant` for enforcing that at the database.
