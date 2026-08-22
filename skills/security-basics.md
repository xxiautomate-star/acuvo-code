---
name: security-basics
description: The handful of vulnerabilities that actually occur — XSS, injection, secrets, and safe defaults
when: When handling user input, rendering it back, calling a database, or touching a credential
---

# Security basics

Not the whole OWASP list — the few that actually turn up in application code.

## ⚠️⚠️ XSS: never build HTML by concatenating input

```js
✗ el.innerHTML = `<p>Hello ${name}</p>`;     // name = "<img src=x onerror=alert(1)>"
✓ el.textContent = `Hello ${name}`;
✓ el.append(document.createTextNode(name));
```

`textContent` cannot execute anything. Reach for `innerHTML` only with a string
you built entirely yourself, and treat every alternative as better.

Also XSS, and easier to miss:

```js
✗ <a href={userSupplied}>          // "javascript:…" runs on click
✗ el.setAttribute('onclick', …)
✗ eval(…) / new Function(userInput) / setTimeout("string")
```

For a URL, check the scheme against an allowlist (`https:`, `http:`, `mailto:`)
rather than looking for bad ones.

## Injection: the query is code, the input is data

```js
✗ db.query(`SELECT * FROM users WHERE email = '${email}'`)
✓ db.query('SELECT * FROM users WHERE email = $1', [email])
```

Parameterise. Escaping by hand fails on the case you did not think of. The same
rule applies to shell commands: pass an argument array, never build a string.

## ⚠️⚠️ Secrets

- Never in client code. Anything shipped to a browser is public — a "hidden"
  API key in a bundle is a published API key.
- Never in the repository. `.env` is gitignored; `.env.example` holds the names
  with no values.
- Never in a log line, an error message, or a URL (URLs land in history and in
  access logs).
- A leaked key is rotated, not deleted from the history — assume it was read.

## CSRF

A cookie-authenticated state-changing request needs more than the cookie, since
the browser attaches it automatically from any origin. `SameSite=Lax` covers
most of it; add a token for the rest. `GET` must never change anything.

## Validate on the server, always

The client's validation is for the user's benefit. Re-check types, ranges,
lengths and permissions on arrival — every value, every time, including ones a
dropdown "could only" have produced.

## Safe defaults

- **Deny by default.** New endpoint, no explicit permission check → it should
  fail closed, not open.
- **Least privilege.** The database user for the app does not need `DROP`.
- **Do not tell an attacker why.** "Email or password is incorrect" — not
  "no such user", which turns your login form into a list of who has an account.

## ⚠️ Dependencies are your code

A package you added runs with your permissions. Prefer fewer, prefer maintained,
and read what a postinstall script does before it runs on your machine.
