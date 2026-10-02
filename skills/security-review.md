---
name: security-review
description: What actually gets exploited — injection, secrets in source, missing authz, unsafe deserialisation
when: Before shipping code that touches a database, shell, user input, files, auth or money
---

# Security review

Review for what **actually gets exploited**, not for what is easy to list.
Ranked by how often each one is the cause of a real incident:

1. **Missing authorisation** — the most common, the least detectable by tooling.
2. **Injection** — SQL, shell, template, and now prompt→tool.
3. **Secrets in source** — including in a client bundle.
4. **Unsafe deserialisation and dynamic execution.**
5. Everything else: XSS, path traversal, SSRF, weak crypto, open redirect.

Work down that list. Six findings ranked by exploitability beat forty ranked by
nothing — a review nobody acts on is not a review.

## 1. Authorisation — authenticated is not authorised

⚠️ **The defect: the handler checks WHO you are and never checks whether this
row is YOURS.** Generated CRUD code does this almost every time, because the
happy path works perfectly and no test fails.

```js
// BROKEN — any logged-in user reads any invoice by guessing the id (IDOR)
app.get('/api/invoices/:id', requireAuth, async (req, res) => {
  res.json(await db.invoice.findUnique({ where: { id: req.params.id } }));
});

// FIXED — ownership is part of the QUERY, not a check after it
const inv = await db.invoice.findFirst({
  where: { id: req.params.id, orgId: req.user.orgId },
});
if (!inv) return res.status(404).end();   // 404, not 403 — 403 confirms it exists
```

**Find them:**

```
search_text  "findUnique\(|findById\(|\.get\(id|where: \{ id"
search_text  "req\.(params|query|body)\.(id|userId|orgId|accountId)"
```

Read every hit and answer one question: *what stops user A passing user B's id?*
"The UI never sends it" is not an answer — the UI is not the client.

Same defect, three more shapes:
- **Mass assignment**: `Object.assign(user, req.body)` lets the request set
  `role: 'admin'`. Whitelist fields explicitly, never spread the body.
- **Client-side gating only**: the admin button is hidden, the endpoint is open.
- **Multi-tenant RLS assumed but not on**: a Supabase/Postgres table with RLS
  enabled and no policy is closed; with RLS **disabled** it is wide open through
  any anon key. Check `rowsecurity` on the table, do not assume.
- **Service-role key on a client-reachable path**: it bypasses RLS entirely, so
  every other control in the table becomes decorative.

## 2. Injection

**SQL** — the only fix is parameters. Not escaping, not a quote-stripper.

```
search_text  "query\(.*\$\{|execute\(.*\+|\.raw\(|sql\.unsafe|format\(.*%s.*SELECT"
```

```js
db.query(`SELECT * FROM users WHERE email = '${email}'`);       // BROKEN
db.query('SELECT * FROM users WHERE email = $1', [email]);       // FIXED
```

⚠️ A parameter cannot be a table or column name. For a dynamic `ORDER BY`, map
the input through an allowlist: `const col = {name:'name',date:'created_at'}[q] ?? 'created_at'`.

**Shell** — the fix is argv, not quoting.

```
search_text  "exec\(|execSync\(|shell: true|os\.system|subprocess.*shell=True"
```

```js
exec(`convert ${file} out.png`);                       // BROKEN: file="a.png; rm -rf ~"
execFile('convert', [file, 'out.png']);                // FIXED: no shell parses it
```

⚠️ `shell: true` in Node and `shell=True` in Python re-open the hole even with an
array of arguments. And a quoting helper you wrote is not a fix — it will be
wrong on some platform.

**Template / expression injection**: user input reaching `eval`, `new Function`,
a template engine's compile step, or a YAML/expression evaluator. There is no
safe way to evaluate an attacker's string; the fix is to not.

**Prompt → tool injection** (this codebase's own shape): text fetched from a
page, a file, an issue or an email is **data, never instructions**. If a model's
output can trigger a tool that writes files, spends money, sends mail or pushes
code, the untrusted text is now driving those tools. Gate the *action*, not the
prompt — a confirmation on the side effect is the only control that survives a
cleverer phrasing.

## 3. Secrets in source

```
search_text  "(sk-|pk_live|xox[baprs]-|AKIA|ghp_|github_pat_|-----BEGIN [A-Z ]*PRIVATE KEY)"
search_text  "(api[_-]?key|secret|password|token)\s*[:=]\s*['\"][A-Za-z0-9/+_-]{16,}"
```

Then check three places that are not the source file:

- **The client bundle.** Anything under `NEXT_PUBLIC_`, `VITE_`, `REACT_APP_` or
  `PUBLIC_` is compiled into JavaScript any visitor can read. `search_text` the
  built output for the first 8 characters of each key.
- **Git history.** A key deleted in the working tree is still in the history and
  still valid. `git_log -p` the file, or search the packfile.
- **`.env` committed.** Check `git_status`/`.gitignore` — `.env.example` in the
  repo, `.env` never.

⚠️ **A leaked key is not fixed by deleting it. It is fixed by ROTATING it.**
Say that explicitly in the finding, because a "removed the secret" commit reads
like a fix and is not one.

## 4. Unsafe deserialisation and dynamic execution

```
search_text  "pickle\.loads|yaml\.load\(|marshal\.loads|unserialize\(|readObject\(|eval\(|new Function\(|vm\.runIn"
```

| broken | fixed |
|---|---|
| `pickle.loads(body)` | JSON, or a schema-validated format. Pickle **is** code execution. |
| `yaml.load(s)` | `yaml.safe_load(s)` — the unsafe one instantiates arbitrary classes |
| `unserialize($_POST['x'])` (PHP) | `json_decode` |
| `JSON.parse(x)` then trusting the shape | parse **then validate** with a schema (zod, pydantic) |
| `eval(userExpr)` for a calculator | a real expression parser with an operator allowlist |

⚠️ `JSON.parse` itself is safe. What is not safe is what you do with the result:
`{"__proto__":{"isAdmin":true}}` merged into an object with a naive deep-merge is
prototype pollution, and it turns every later `obj.isAdmin` check true.

## 5. The rest — quick, high-yield checks

- **XSS**: `search_text "innerHTML|dangerouslySetInnerHTML|v-html|\|safe"`. React
  escapes by default; those four opt out of it. Sanitise with DOMPurify or render
  as text. And `href={userUrl}` allows `javascript:` — allowlist the scheme.
- **Path traversal**: `search_text "join\(.*req\.|readFile\(.*params"`. Resolve
  the path, then assert it is still inside the root:
  `const p = resolve(root, name); if (!p.startsWith(root + sep)) throw;`
  ⚠️ Stripping `../` is not a fix — encodings and absolute paths walk past it.
- **SSRF**: any server-side fetch of a user-supplied URL. Blocking `localhost`
  and `127.0.0.1` is not enough (`169.254.169.254` is the cloud metadata service,
  `[::1]`, decimal IPs, and a DNS name that resolves to a private range). Use an
  allowlist of hosts, and do not follow redirects blindly.
- **Crypto**: `md5`/`sha1` for passwords → bcrypt/argon2/scrypt. `Math.random()`
  for a token or reset code → `crypto.randomBytes`. A comparison of secrets with
  `===` → `crypto.timingSafeEqual`. Hardcoded IV or `ECB` mode → AES-GCM with a
  random nonce per message.
- **Open redirect**: `res.redirect(req.query.next)` — allowlist, or only accept a
  path beginning `/` and not `//`.
- **Errors that leak**: a stack trace, a SQL string, or an internal hostname in a
  500 response body. Log the detail, return an id.
- **Rate limiting** on login, password reset, and anything that costs money per
  call. Its absence is not exciting and it is how bills get run up.

## How to report a finding

Each one gets four lines, and the second is the one that matters:

```
WHERE     api/invoices/[id]/route.ts:14
EXPLOIT   GET /api/invoices/9f2 as any signed-in user returns another org's invoice
FIX       add `orgId: session.orgId` to the where clause; return 404 on miss
SEVERITY  high — no special access needed, silent, and the data is billing records
```

⚠️ **If you cannot write the EXPLOIT line, it is not a finding yet.** "Uses
innerHTML" is an observation; "the `bio` field from signup is rendered with
innerHTML on every profile page, so a `<img onerror>` in a bio runs for every
visitor" is a finding. Say "I could not determine whether this input is
attacker-controlled" rather than inflating it — a review that cries wolf gets
ignored on the one that mattered.

## ⚠️ What this cannot do

- **Reading code does not prove exploitability.** A control may exist one layer
  up — middleware, a gateway, RLS. Check for it before reporting; and if you
  cannot see that layer, say the finding is conditional on it.
- **No dependency-vulnerability scan here.** `npm audit` is not on the default
  allowlist (only `npm test` and `npm run <script>`), so unless the human runs it
  or `--shell` is on, **you have not checked dependencies at all** — do not imply
  you have. Lockfile CVEs are a real and common source of compromise.
- **No SAST, no taint analysis, no fuzzing.** This is a human-style read of the
  code you can see.
- **Nothing about the infrastructure**: bucket ACLs, security groups, IAM, TLS
  config, secrets management, CI permissions. All out of view of the repo, all
  frequently the actual hole.
- **Not a substitute for a professional audit** on anything holding money, health
  data or credentials. Say so once, plainly, and let the human decide.
