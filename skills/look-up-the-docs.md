---
name: look-up-the-docs
description: Get the CURRENT, version-specific API of a library from its own source before you write against it — instead of recalling one from training
when: Before writing code against any library, framework or SDK you have not just read in this workspace — and always the moment a version number matters; also to understand someone else's repo or repository, to find real usages of an API in open-source code, or for Azure/AWS/Cloudflare docs
---

# Look up the docs before you write the code

Your weights have a date. The library does not. The single most common way a
generated file is wrong is not bad reasoning — it is a correct answer for a
version nobody is running.

## ⭐ The order, and it is an order, not a menu

**1. Read what this workspace actually installs.** It is already in front of you:
the system message lists every dependency with the version resolved from
`node_modules`, not the range declared in `package.json`. A caret range is not a
version — `^3.700.0` on this machine resolved to `3.1058.0`, which is 358 minors
away.

⚠️ **If any prose in the project — a README, a notes file, a comment — names a
different version from that list, the list is right and the prose is stale.**
This is not hypothetical. A doctrine file in this very repo described the stack
as "Next 16, async params" while `node_modules/next` held 14.2.35, where `params`
is a plain object. An agent that believed the prose wrote `params:
Promise<{id:string}>` into a Next 14 app.

**2. If the `docs` tools are in your tool list, ask them.** Two calls:

```
resolve-library-id({ libraryName: "next.js", query: "route handler" })
  -> /vercel/next.js
query-docs({ libraryId: "/vercel/next.js", query: "how do I define a route handler" })
  -> export async function GET(request: Request) {}
     Source: github.com/vercel/next.js/blob/canary/docs/.../route-handlers.mdx
```

⚠️ **Both arguments are required on `resolve-library-id`, and its error message
names only the one you DID pass.** Give it `libraryName` and it complains about
`query`; give it `query` and it complains about `libraryName`. Send both.

⭐ **Prefer the returned SNIPPET over a summary of it.** Each one carries a source
URL into the library's own repository. That is evidence; a search result about
the library is material you would still have to derive the answer from.

**3. Otherwise use `web_search`, and read it knowing what it is.** It ranks by
POPULARITY, so for a library question the top hit is usually the idiom that was
correct three major versions ago and got linked the most since. It is a good
answer about concepts and a poor one about signatures.

**4. Last resort: read the types on disk.** `node_modules/<pkg>/` holds the
`.d.ts` and the README for the exact version installed. Slower to read, and it
cannot be out of date.

## ⚠️ When to stop and look it up

Not always — a lookup costs a round, and for `Array.map` it is waste. Do it when
any of these is true:

- you are about to write an **import, a config key, or a function signature** for
  a library you have not read in this session
- the answer you are about to write **depends on a major version** (routing, data
  fetching, auth, build config, ORM query syntax)
- something you wrote **failed with "is not a function", "unknown option", or a
  type error naming a property that should exist** — that is a version mismatch
  until proven otherwise, and guessing again is the expensive move
- the user named a version, or the installed version is **newer than you expect**

⚠️ A jsDelivr URL returning **200 is not proof the file exists upstream**: it
minifies on the fly and serves a generated file with a "do NOT use SRI" banner.
Never treat a CDN 200 as evidence of a real build artifact.

## ⭐ The keyless knowledge shelf — eleven servers, no key, no account

Step 2 says "if the `docs` tools are in your tool list". `docs` is one of
**eleven** servers Acuvo has measured; every one of them connects with no API
key and no sign-up, and every row below was connected AND called for real on
**2026-09-19**. Their tools arrive named `mcp__<server>__<tool>`.

⚠️ **None of them is on until somebody turns it on.** If the tools are not in
your list, say which server would have answered and why — the person adds it
with `acuvo mcp add <name>` in one line. If you *do* see a `use_toolset` tool,
that is the door: call it with the server name and its tools are loaded.

| server | it answers | its tools |
|---|---|---|
| `docs` | the current, version-specific API of any library, as source-cited snippets | `resolve-library-id`, `query-docs` |
| `deepwiki` | how a public GitHub **repository** works — architecture, entry points, a subsystem | `ask_question`, `read_wiki_structure`, `read_wiki_contents` |
| `grep` | how an API is **really used** — regex search over a million public repos' source | `searchGitHub` |
| `mslearn` | Microsoft's own docs — Azure, .NET, TypeScript, VS Code, Windows | `microsoft_docs_search`, `microsoft_code_sample_search`, `microsoft_docs_fetch` |
| `awsdocs` | AWS's own docs, and which services exist in a given region | `aws___search_documentation`, `aws___read_documentation`, `aws___list_regions`, `aws___get_regional_availability` |
| `cloudflare` | Workers, KV, D1, R2, Durable Objects — Cloudflare's own docs | `search_cloudflare_documentation`, `migrate_pages_to_workers_guide` |
| `huggingface` | models, datasets and Spaces — including **a weight's licence**, before you adopt it | `hub_repo_search`, `hub_repo_details`, `hf_fs` |
| `svelte` | ⭐ **compiles your snippet** and returns Svelte's own errors — it verifies, it does not describe | `svelte-autofixer`, `get-documentation`, `list-sections` |
| `astro` | Astro's own docs — content collections, islands, adapters | `search_astro_docs` |
| `convex` | Convex's own schema, index and scaling guidance | `get_convex_scaling_guidance`, `add_convex_to_existing_project` |
| `clerk` | Clerk's current auth snippets — B2B orgs, waitlists, roles | `list_clerk_sdk_snippets`, `clerk_sdk_snippet` |

⭐ **`svelte-autofixer` is the one that is not a search.** It compiles what you
hand it. Two required arguments and the second is not guessable: `code` **and**
`desired_svelte_version` (an integer — 5). It also returns
`require_another_tool_call_after_fixing: true`, so one clean round is not a
clean bill of health.

⚠️ **`deepwiki` and `grep` see PUBLIC repositories only.** Asking `deepwiki`
about a private repo cannot work *and leaks the name of what you asked*.

## ⚠️ What leaves the machine

`query-docs` and `web_search` are network services: the text you send — often the
user's actual problem statement — goes to a third party. Reading `node_modules`
and the dependency list does not. If the task is under a confidentiality
constraint, use steps 1 and 4 and say that you did.

## ⭐ The one sentence

An API you recalled is a hypothesis; an API with a source URL is a fact — and the
difference costs one round and saves the whole file.
