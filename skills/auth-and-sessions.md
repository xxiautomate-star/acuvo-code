---
name: auth-and-sessions
description: Sign up, sign in, session, sign out with AcuvoAuth — and what accounts here do NOT make private
when: When the app needs accounts, a login, members, a profile, or anything per-user
---

# Accounts and sessions

## ⭐ In a generated Acuvo app: `window.AcuvoAuth`, already injected

Never define it, never `fetch` a URL, never write a token, and **never store a
password**. It is on `window` before your first script runs.

```js
await AcuvoAuth.signUp(email, password); // creates the account AND signs in → { id, email }
await AcuvoAuth.signIn(email, password); // → { id, email }
await AcuvoAuth.me();                    // → { id, email } or null. Server-checked EVERY call.
await AcuvoAuth.signOut();               // → true. Signing out twice is a success, not an error.
```

Passwords are hashed server-side (scrypt, per-user salt) and are **never returned**.
Minimum 8 characters, maximum 200; emails up to 254. Sessions last 30 days.

## The whole loop, which is about 30 lines

```js
async function paint() {
  const user = await AcuvoAuth.me();           // ⚠️ on EVERY load — this is the source of truth
  document.body.dataset.signedIn = user ? 'yes' : 'no';
  if (user) {
    who.textContent = user.email;
    await refreshList();                        // now load what this app shows
  }
}

signUpForm.addEventListener('submit', async (e) => {
  e.preventDefault();                           // form-action is 'none' — see forms-and-validation
  try {
    await AcuvoAuth.signUp(email.value.trim(), password.value);
    await paint();
  } catch (err) {
    // err.code is stable, err.message is written for a human. Show the message.
    showError(err.message);                     // 'email_taken' | 'weak_password' | 'bad_email' | …
  }
});

signOutButton.addEventListener('click', async () => { await AcuvoAuth.signOut(); await paint(); });
```

`err.code` is one of: `bad_email`, `weak_password`, `invalid_credentials`,
`email_taken`, `session_expired`, `bad_token`. Branch on the code, show the message.

## ⚠️ The session is TAB-SCOPED. That is deliberate, and do not "fix" it.

The session token lives in `sessionStorage`, which on a shared app is backed by
`window.name` — tab-scoped and never sent to the server. So **a new tab starts
signed out**, and closing the tab ends the session. Say so in the UI if it matters.

⛔ Writing the session token to `localStorage` to "keep people signed in" was a
real, shipped **account takeover**: on `/p/<token>` localStorage is one
server-side blob shared by every visitor, inlined into the HTML — so visitor B
loaded a page carrying visitor A's session token, in View Source. Keys starting
`__acuvo` are now stripped on the way in, but the point stands: do not try.

## ⚠️⚠️ `me()` tells you WHO. `AcuvoData.private` is what makes data PRIVATE.

Plain `AcuvoData` is one store per app link: everyone who can open the app can
read and overwrite **every** record in it, signed in or not. Signing someone in
does not change that by itself.

```js
✗ await AcuvoData.set('notes_' + user.id, id, diaryEntry);        // any visitor can read this
✗ await AcuvoData.set('notes', user.id + '_' + id, diaryEntry);   // same thing. Still public.
✓ await AcuvoData.private.set('notes', id, diaryEntry);           // only this account. Enforced in SQL.
```

⭐ **`AcuvoData.private` is the same five verbs, scoped BY THE SERVER to the
signed-in account** — `set` `get` `list` `remove` `clear`. The row carries an
owner and every statement filters on it, so no account can read or overwrite
another's, whatever the browser sends. Use it for anything one person owns:
their notes, their jobs, their bookings, their saved settings.

```js
const me = await AcuvoAuth.me();
if (!me) return showSignIn();                        // private needs a session — there is no owner without one
const { items } = await AcuvoData.private.list('jobs');
```

⚠️ **Prefixing a key with a user id is organisation, not security**, and neither
is filtering in the browser — `list()` on the shared store hands the browser
every record before your `.filter()` runs. That was measured: a second account
could read every other account's records with one call in the console. If it
must be private, it goes in `AcuvoData.private`; the shared store is for what
everyone with the link is meant to see.

⚠️ The private store still is not a vault for secrets — never a password, never
an API key. It is "only this account can read it", not "encrypted at rest".

⚠️ Do not gate anything that matters on `AcuvoAuth.me()` in the browser either —
hiding a button is presentation, and the person you are hiding it from controls
the browser.

---

# On a real server (the CLI, a Next.js app, an API you own)

Everything above is about a generated app with no backend of its own. When you
DO have a server, these are the rules.

## ⚠️⚠️ The re-signin bug — nearly always one of two causes

A user is signed in, clicks something, and lands on the login page.

**1. A failed refresh treated as "signed out".**

```js
✗ const { user } = await getUser();
  if (!user) redirect('/login');   // a 500 from the auth server looks identical to a real logout
```

| what happened | correct response |
|---|---|
| valid session | continue |
| **401 / 403** — the token is genuinely bad | sign out |
| **network error, 5xx, timeout** | **do NOT sign out** — retry, or fail the request |

Destroying a session because the auth service had a bad second is the bug. Read the
status, not just the absence of a user. This is `error-handling`'s rule — *empty ≠
unreadable* — applied to identity.

**2. Two things refreshing the same token at once.** Concurrent refreshes race; one
rotates the token, the other presents the stale one and is rejected. Single-flight
it: one in-flight promise every caller awaits.

## Sessions expire — plan the moment

- Short-lived access token + long-lived refresh token is the standard shape.
- Refresh **before** expiry, not on the 401 — a refresh triggered by a failure means
  the user already saw an error.
- When the session really is over, **preserve what they were doing**. Sending someone
  to a bare login screen after they typed a long form is the part that makes people
  angry, not the logout.

## The client cannot be the gate

```js
✗ if (user.role === 'admin') showDeleteButton();   // and the endpoint checks nothing
✓ the endpoint verifies the caller may delete THIS row, every time
```

Route protection in a framework is convenience. An unprotected API under a protected
page is still an unprotected API.

## Passwords, if you must hold them

Never recoverable. `bcrypt`, `scrypt` or `argon2` — never a plain hash, never your own
scheme, always a per-user salt, compared in constant time. Better: do not hold them.
An OAuth provider or a magic link removes the whole class of problem, including the
breach you would otherwise have to disclose.

## Cookies

`HttpOnly` (JavaScript cannot read it, so XSS cannot steal it), `Secure`,
`SameSite=Lax` by default. A token in `localStorage` is readable by every script on
the page, including one that arrived through a dependency.

## ⚠️ Multi-tenant: the row belongs to a tenant, not to a user

Every query filters by tenant, and the filter comes from the **session**, never from
a parameter the caller supplied. `?tenant=other-company` is the whole attack. See
`supabase-multitenant` for enforcing it at the database.

## Sign in with Google

When the host has a Google client, `AcuvoAuth.signInWithGoogle()` is present
beside the email calls. It navigates the page to Google and back; the page
reloads signed in, exactly as after `signIn`.

```html
<button id="google" type="button">Continue with Google</button>
<script>
  document.getElementById('google').addEventListener('click', async () => {
    try { await AcuvoAuth.signInWithGoogle(); }
    catch (err) {
      // use_share_link: the builder preview is a frame and Google will not render in one.
      status.textContent = err.code === 'use_share_link' ? 'Open the app on its share link to sign in with Google.' : err.message;
    }
  });
  // On load, as always:
  AcuvoAuth.me().then((user) => { /* render signed-in or signed-out */ });
  const last = AcuvoAuth.lastError && AcuvoAuth.lastError();
  if (last) status.textContent = last;   // e.g. "You cancelled the Google sign-in."
</script>
```

An account created by Google has no password; an email that already has a
password account is linked, never duplicated. Private data
(`AcuvoData.private`) works identically whichever way the person signed in.

## Who may read or write a collection

Write `data/rules.json` and the save registers it — no code on the page:

```json
{ "admins": ["owner@example.com"],
  "enquiries": { "read": "admins", "write": "public" },
  "orders":    { "read": "users",  "write": "admins" } }
```

`public` = anyone with the app, `users` = signed in with AcuvoAuth, `admins` = an account
**the owner granted** in the project's Accounts panel.

⚠⚠ **LISTING AN EMAIL UNDER `"admins"` DOES NOT MAKE THAT PERSON AN ADMIN.** The array
only DECLARES who the app is for, and the rules file is served with the app, so anyone can
read it. It used to BE the grant, and that was a fake gate: sign-up creates the account and
opens the session in one call without verifying the address, so the first stranger to read
the file and sign up as the address in it became the admin — and `read: "admins"` handed
them every enquiry. The grant is now a deliberate press by the owner, recorded on
`project_app_users.is_admin`.

Shared scope only; `AcuvoData.private` stays per person; a
collection without a rule is open as before. Server functions, agents, schedules and jobs
always pass. A refused call answers `401`/`403` with `code: 'forbidden'` and `needs`; show
the sign-in, never retry in a loop. This is what a lead form needs: customers write
`enquiries`, and you read them **once the owner has granted their account admin** — saying
"only you can read these" the moment the file is saved would be telling them something
that is not yet true.
