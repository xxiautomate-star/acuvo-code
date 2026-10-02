# Acuvo Code as an MCP server — the honest business case

> Written 2026-08-10. Every number below is either **measured** (I ran it, command shown),
> **cited** (URL), or **labelled a guess**. If a figure has none of those three, it should
> not be here and you should delete it.

---

## VERDICT FIRST

**As a product or a revenue line: no. Do not build it.**

**As a one-day free distribution experiment with a pre-committed kill date: yes, but only
after the CLI has an install path at all** — and today it does not. Measured 2026-08-10:

```
curl -o /dev/null -w "%{http_code}" https://github.com/xxiautomate-star/acuvo-code  → 404
curl -o /dev/null -w "%{http_code}" https://registry.npmjs.org/acuvo-code           → 404
```

`MVP-PLAN.md:76-78` already flags the missing GitHub repo as the single biggest gap in
the product. An MCP server is a *distribution channel*. Building a channel to a product
that cannot be installed is building a road to a field.

The rest of this document is why the revenue thesis fails specifically, so nobody
re-derives it in three weeks.

---

## 1. What the MVP actually is

The smallest shippable thing, concretely — no strategy, just the artifact:

**`acuvo mcp serve`** — one new subcommand in `bin/acuvo.mjs`, one new file
`lib/mcp-server.mjs`, stdio transport only (no HTTP, no OAuth, no hosting), exposing
exactly the five tools that Acuvo Code has and a generic coding agent does not:

| tool | what it wraps | current state in this repo |
|---|---|---|
| `see_page` | `seePage()` — render local HTML, return measured findings + a PNG on disk | `lib/media.mjs:125-197`, works |
| `make_document` | HTML → PDF / PNG / PPTX | `lib/media.mjs:207-225`, works |
| `transcribe` | faster-whisper on Modal | `lib/media.mjs:181-204`, works |
| `speak` | Kokoro-82M on Modal | `lib/media.mjs:167-178`, works |
| `generate_image` | image endpoint | `MVP-PLAN.md:44` — **endpoint 502s**, marked ⚠️ |

Concretely it is: read JSON-RPC frames on stdin, answer `initialize`, answer `tools/list`
with five schemas, dispatch `tools/call` into the functions that already exist, write
JSON-RPC frames to stdout. Zero dependencies (the repo has none —
`package.json:"dependencies":{}` — and MCP over stdio does not require any). Plus a
README block with the install line and a `.mcp.json` snippet.

**Honest size estimate: one to two days.** That is a guess, not a measurement — but it is
a guess bounded by the fact that `lib/mcp.mjs` (381 lines) already implements the *client*
half of the same wire protocol, so the framing, handshake and error shapes are known code.

**Explicitly NOT in this MVP:** hosted/remote transport, OAuth, metering, entitlements,
a Claude Connectors Directory submission, or exposing the agent loop. Each of those is a
week or more and each is separately argued against below.

---

## 2. ⭐ Why anyone pays — they don't, and here is the evidence

**Lead with the conclusion: on the evidence available, essentially nobody pays for this,
and the reason is not price. It is that four of the five tools have a free first-party
alternative already installed in the buyer's client.**

### 2a. The buyer, named

The buyer would be a developer paying for Claude Code (Max $100–200/mo), Cursor
($40/seat), or Copilot ($39/user) — the only people with MCP clients and a tool budget.
Source for the price points: <https://www.developersdigest.tech/blog/ai-coding-tools-pricing-2026>.

### 2b. The moment they hit a wall

The real moment exists and is worth stating precisely, because it is the strongest thing
in this document: **the model writes a landing page, and its own description of the page
is not evidence.** It says "clean hero, good contrast" and the H2 is white on white.
`see_page` is the only tool in this repo that closes that gap, and the code comment at
`lib/media.mjs:151-158` records the one time it *failed* to — returning `looked: true`
with an empty findings array, issuing all-clears for pages it never saw. That bug is the
proof the capability is real: it mattered when it broke.

### 2c. Why the wall does not convert into money

The buyer hits that wall inside Claude Code. And Claude Code shipped a native in-app
browser in July 2026 (v2.1.202–206) that renders with full JS/CSS, screenshots, clicks
and annotates — included in Pro and Max at no extra cost, working in the CLI in both
interactive and non-interactive modes
(<https://code.claude.com/docs/en/whats-new/2026-w28>,
<https://www.mindstudio.ai/blog/claude-code-in-app-browser-web-research-visual-editing>).
Cursor's own docs say of its browser tools: *"You can use Browser without installing or
configuring any external tools"* (<https://cursor.com/docs/agent/tools/browser>).

So the sentence at `lib/tools.mjs:119-121` and `lib/media.mjs:17-25` — *"Every other
terminal agent is BLIND... no other coding CLI can render its own output"* — **is false
as of five weeks ago.** It should be struck from the source comments before someone
repeats it to a customer. It was true when it was written. It is not true now.

### 2d. The buyer is also the wrong buyer, and this repo already said so

`MVP-PLAN.md:29-32`, verbatim:

> *"Terminal coding agent and creative tool are different shelves. We keep the media
> because it is already built and free to carry — not because it wins the backend-engineer
> crowd. It will not."*

An MCP server distributes exclusively through Claude Code / Cursor / Codex — a channel
whose population is backend engineers. It sells a bundle of decks, PDFs, voice and images
— a bundle aimed at marketers and solo founders. **We would be paying distribution cost
to reach the population our own planning document identified as the least likely to buy.**
That is the single strongest reason this fails and it was written down before anyone
proposed the MCP server.

### 2e. What survives

One thing, and it is narrower than the pitch: **the shape of the return value.**
`seePage` returns a findings array of sentences (`lib/media.mjs:190`, `findingsFrom` at
`:208`) rather than an image. A secondhand claim — Claude Code issue #31208, which I have
**not** independently verified — is that MCP tools returning `ImageContent` cost
~15,000–25,000 tokens versus ~1,600 for a natively-attached image, a 10–20× tax that
recurs on every iteration of a render→fix loop. **Treat that ratio as unverified.** If it
is true, the value here is a token-cost saving, not a capability. That is a software
convention, reproducible in a weekend with local Playwright plus injected measurement JS,
and Anthropic will probably fix the underlying issue.

---

## 3. Why a free alternative does not already solve it — it does, for four of five

I measured the two that matter, today, against `api.npmjs.org`:

```
@playwright/mcp        last month: 25,901,643 downloads   (Microsoft, Apache-2.0)
chrome-devtools-mcp    last month:  7,541,930 downloads   (Google, Apache-2.0)
```

Both are loaded and callable in the session that produced this document. `chrome-devtools-mcp`
ships Lighthouse audits and performance traces — strictly *more* measured page feedback
than `see_page` returns. `@playwright/mcp` ships `browser_evaluate`, which lets any agent
read `getBoundingClientRect` and computed styles directly, and `browser_pdf_save` behind
`--caps=pdf` (<https://github.com/microsoft/playwright-mcp>).

Tool by tool:

| our tool | free alternative | verdict |
|---|---|---|
| `see_page` | Claude Code native browser; playwright-mcp; chrome-devtools-mcp | **solved, better, free, pre-installed** |
| `make_document` (PDF) | `browser_pdf_save` in playwright-mcp; Anthropic's own pdf Agent Skill | **solved** |
| `make_document` (PPTX) | html2pptx.app MCP; Office-PowerPoint-MCP-Server; Anthropic's pptx Skill | **solved, thinnest coverage of the three** |
| `transcribe` | `whisper-transcribe-mcp` (MIT) wraps faster-whisper — *the same engine* (`lib/media.mjs:180`) | **solved, and runs locally** |
| `speak` | free Kokoro MCP servers wrap Kokoro-82M — *the same Apache-2.0 model* (`lib/media.mjs:166`) | **solved, and runs locally** |
| `generate_image` | FAL, Replicate, Pollinations, Higgsfield MCP | **solved, and ours is 502ing** |

And our versions are **structurally worse**, not merely equal. Every media capability is a
remote HTTPS call to a Modal URL read from the environment (`lib/media.mjs:64-73`), with
`DEFAULT_TIMEOUT_MS = 180_000` and `RENDER_TIMEOUT_MS = 240_000` (`lib/media.mjs:52-54`)
and a cold-start apology baked into the error string (`lib/media.mjs:99-101`). The free
alternatives run a local process in seconds for $0.

There is one more fact worth absorbing: **`claude mcp serve` already exists.** Verified on
this machine today (`claude mcp --help` lists `serve [options]  Start the Claude Code MCP
server`). "Claude Code is not an MCP server" is not a gap we are filling.

**What genuinely is not free:** the *enforced loop* — `turn.mjs` mandates a `see_page`
call after any HTML write and records `looked` so the agent is auditable on whether it
actually looked. No MCP server ships that, because **an MCP server exposes tools, not
loops.** Note the direction of that argument: it says keep the loop inside the agent and
monetise the agent. It argues against this document's subject.

---

## 4. Pricing — unit, number, margin

### The unit

Not seats and not protocol access. Every paid MCP server that works bills metered compute
or a proprietary index:

- **Context7:** $10/seat/mo, 5,000 calls, then $10 per additional 1,000; free tier capped
  at 1,000 calls/mo (<https://context7.com/docs/plans-pricing>). Note: the free tier was
  *cut*, reportedly by ~92%.
- **Ref:** Free 200 one-time credits; Pro $50/mo (6,000); Max $200/mo (30,000); PAYG $10
  per 1,000 (<https://docs.ref.tools/usage/pricing>). Its $9/1,000 rate is now explicitly
  a grandfathered legacy plan — entry price went $9 → $50.
- **Composio:** $29/mo for 200K tool calls, overage $0.299/1K (<https://composio.dev/pricing>).

### The number, and why it collapses

The natural unit here is a render. Market clearing price for "a browser someone else
runs" is **$0.10–0.12 per browser-hour** at Browserbase list
(<https://www.browserbase.com/pricing>). A 20-second render is therefore about
**$0.0007 of compute.** Hosted HTML→PDF sits at $0.001–0.005/doc
(<https://orshot.com/blog/best-pdf-generation-apis>). Whisper is ~$0.02–0.04 per hour of
audio (<https://tokenmix.ai/blog/whisper-api-pricing>).

**You cannot sell something worth seven hundredths of a cent.** Any price you set is
~99.9% gross margin on compute, which reads well on a slide and terribly to a customer,
because it means they are paying for nothing they can point at. Only `generate_image` is
genuinely GPU-bound, and it is both the most commoditised item on the list and the one
currently returning 502s.

Our own Modal spend is roughly consistent with that: memory records Modal's ~$30 balance
as ≈1,400 talking-head renders, i.e. **~$0.02 per heavy GPU job** — that figure is from
the memory index (`project_acuvo_full_cost_surface`), not re-measured for this document,
so treat it as approximate. A page render is far cheaper than a talking head.

### The realistic ceiling, if you priced it anyway

$19/mo is the only viable point — below it decision friction exceeds value, above ~$29 it
becomes a procurement conversation. The one operator who published a funnel reports ~1.5%
install-to-paid, meaning **~1,700 installs for $500 MRR**
(<https://dev.to/whoffagents/pricing-an-mcp-server-in-2026-why-we-charge-19mo-when-the-market-average-is-0-nig>).
⚠️ **That source is an AI-authored self-published marketing post** which states it was
"drafted, fact-checked, and shipped autonomously." Its "26 customers for $500 MRR" is
literally $500 ÷ $19. **Do not treat any number from it as data.** I include it because
it is the only funnel anyone has published at all, and that absence is itself the finding.

We are at **0 installs** (both 404s above). $500 MRR is therefore not a pricing problem.

---

## 5. ⭐ Is this better than making the CLI bigger?

### The argument, stated at full strength

Every competitor's user becomes reachable. There are ~20,854 distinct servers in the
official MCP registry — measured by full cursor pagination of
`registry.modelcontextprotocol.io/v0/servers?version=latest`, reproduced independently to
within two records. MCP is now neutral infrastructure under the Linux Foundation's Agentic
AI Foundation with AWS, Anthropic, Google, Microsoft and OpenAI as platinum members, at
97M monthly SDK downloads
(<https://blog.modelcontextprotocol.io/posts/2025-12-09-mcp-joins-agentic-ai-foundation/>).
`@playwright/mcp` alone does 25.9M npm installs a month through a one-line CLI command.
The channel is real, the install friction is one line, and the marginal cost of shipping
into it is a weekend. Rivals stop being obstacles and become funnels. `MVP-PLAN.md:174-176`
already states this: *"⭐ That turns competitors into distribution."*

### Now attack it

**(a) "Reachable" is not "reached."** The registry number does not mean 20,854 peers, and
by the same token it does not mean 20,854 slots of attention. One publisher,
`io.github.pipeworx-io`, holds **1,311 entries — 6.3% of the entire registry** — all on
one host, with 31 byte-identical tools across them. Probing 400 random active remote
endpoints: 12.5% hard-dead; excluding pipeworx, only **48% answered**. Over half the
registry was published in the last three months. This is a publish rush, not a demand
signal. Being one of 20,854 gets you nothing; ~2,000 new servers land per month.

**(b) The channel is owned by the people we are competing with.** The curated surfaces —
Anthropic's connector directory and ChatGPT's ~65-app directory
(<https://chatgptappsrank.com/state-of-chatgpt-apps-2026>) — have **no paid placement**,
and Anthropic states ranking is usage-based. That is normally framed as fair. For a new
entrant with zero usage it is the specific fact that makes the surface unenterable: you
cannot buy out of the cold start. Connector submission additionally requires a Team or
Enterprise org (<https://claude.com/docs/connectors/building/submission>), though the
plugin path via platform.claude.com is free (<https://claude.com/docs/plugins/submit>).

**(c) It inverts the product.** Acuvo Code's thesis is a *loop* — write, run, fail, fix;
render, look, fix. MCP is a *tool-call* protocol. Exposing our tools over MCP hands the
loop to Claude Code's orchestrator and keeps only the leaf calls, which are exactly the
commodity part (§3). We would be giving away the copyable half and keeping the bill.

**(d) It bets on the channel that is currently losing the argument.** "MCP is dead, long
live the CLI" was a live debate in early 2026; a browser-automation benchmark had CLI
beating MCP 77 vs 60 on task completion with 33% better token efficiency, and the GitHub
MCP server dumps ~55K tokens of schema into context before the agent acts
(<https://www.firecrawl.dev/blog/mcp-vs-cli>,
<https://milvus.io/blog/is-mcp-dead-cli-and-skills-for-ai-agents.md>). Acuvo Code's
current advantage is that it is CLI-native. This moves it into the contested lane.

**(e) Opportunity cost, named.** `MVP-PLAN.md:166-168` names the demo that sells this
product: **`acuvo --issue 42`** — read a GitHub issue, branch, fix, run tests, open a PR.
Every piece except the GitHub API calls already exists. `MVP-PLAN.md:107-114` lists
branch/checkout/push/PR as ❌. That is the same one-to-two days, aimed at the loop that is
uniquely ours, in the channel we already occupy. **Making the CLI bigger wins on this
comparison, and it is not close.**

### Where the argument does survive

At **zero cost and zero strategic weight.** If `acuvo mcp serve` is one file and one
README block, the expected value is small but the downside is a weekend. The correct
framing is: it is a free tap, not a strategy. Ship it *after* the repo exists, price it at
$0 forever, never let it appear on a pricing page, and never expose the enforced
render→critique→revise loop through it.

---

## 6. The three ways this fails, concretely

**1. Nobody installs it, because the thing it does is already in the box.**
A Claude Code Max user opens the native browser with Ctrl+Shift+B, or runs
`claude mcp add playwright npx @playwright/mcp@latest` and gets Microsoft's, free, local,
with 25.9M peers vouching for it. To install ours they must set `RENDER_AUDIT_URL`
(`lib/media.mjs:67`), accept a 240-second timeout ceiling (`lib/media.mjs:53`), and trust
an endpoint owned by a company with 0 npm downloads. *Detection:* installs after 30 days.
*Kill threshold:* fewer than 50 installs → delete the subcommand, do not iterate on it.

**2. We ship it, someone pays, and the margin is a rounding error that costs support.**
At ~$0.0007 of compute per render, revenue only becomes non-trivial at volumes we cannot
reach, while every paying customer creates an uptime obligation on a Modal endpoint whose
sibling (`generate_image`) is 502ing today (`MVP-PLAN.md:44`). The failure is not losing
money; it is a small number of paying users converting a side project into an SLA,
against a competitor giving the same thing away. *Detection:* first support ticket about
a cold start. *Kill threshold:* any paid tier at all is the failure — do not build one.

**3. It cannibalises the actual product by teaching users they don't need it.**
This is the one that costs the most and shows up latest. If `see_page` is available from
inside Claude Code, the reason to run Acuvo Code at all is diminished — the media tools
are the advertised differentiator (`lib/media.mjs:17-25`) and we would be renting them to
the incumbent. Meanwhile the loop, the thing genuinely not free, stays invisible because
MCP cannot express it. We would have built our own commoditisation. *Detection:* MCP tool
calls exceeding CLI sessions. *Kill threshold:* if that ratio ever exceeds 1:1, the MCP
server is beating the product and should be withdrawn.

---

## What to do instead — in order

1. **Create the GitHub repo and publish to npm.** Both 404 today. Nothing else on this
   page matters until a stranger can run `npx acuvo-code`.
2. **Fix `generate_image`** (`MVP-PLAN.md:44` — fix committed, undeployed).
3. **Build `acuvo --issue 42`** (`MVP-PLAN.md:166-168`). Same effort, aimed at the loop.
4. **Strike the false claim** at `lib/tools.mjs:119-121` and `lib/media.mjs:17-25`.
   "No other terminal agent can see" was true in June and is false now; a customer will
   disprove it in one keystroke.
5. *Then*, if there is a spare weekend, `acuvo mcp serve` — free, unpriced, kill-dated.

## Weaknesses of this analysis, stated so they are not discovered later

- No paid MCP server has published financials. "The market is tiny" is inferred from
  subscriber anecdotes and one AI-authored blog post, not from revenue data.
- The claim that image-returning MCP tools cost 10–20× the tokens (issue #31208) is
  secondhand and unverified. It is also the strongest surviving argument *for* the idea.
- Registry counts measure supply, not demand. Neither I nor anyone cited has a number for
  how many MCP servers a typical developer actually has installed.
