# MCP servers respawn mid-turn — the defect, and the design that fixes it

**Status:** scoped, not implemented. Deliberately — see *Why this is not a
five-minute change* at the bottom.

---

## The defect, verified in source

`bin/acuvo.mjs`'s `steerable()` runs:

```js
for (;;) {
  const result = await oneTurn(task, prior, { ...over, steerable: true, maxRounds: rounds });
  // …user may steer; loop continues with the same turn
}
```

Every `oneTurn` calls `runSession`, and `runSession` owns the whole MCP
lifecycle itself:

| where | what |
|---|---|
| `turn.mjs:2212` | `let mcpConns = []` |
| `turn.mjs:2312` | `connectAllServers(cfg.servers, …)` — **spawns the processes** |
| `turn.mjs:2317-2318` | `mcpConns.push(...settled)` → `mcpToolSchemas(mcpConns)` |
| `turn.mjs:3017` | `callMcpTool(mcpConns, …)` |
| `turn.mjs:3877` | `releaseMcp()` — **kills them** |

⚠️ **So a steered turn spawns and kills every MCP server once per segment.**

## Why it matters more than the milliseconds

The measured tax is ~330ms per server per segment, which is annoying. The real
cost is **state**:

- `chrome-devtools` and `playwright` are the two servers our own README
  recommends. Both hold a **browser**. Respawning means Chrome relaunches and
  **every tab, cookie, login and scroll position is destroyed between segments
  of the same turn.**
- So the multi-step browser flows those servers exist for — log in, navigate,
  act, verify — are impossible by construction. Not slow: impossible.

⭐ And steering is exactly when it hurts most: the user interjects *because* they
want to redirect work in progress, and the work in progress is what gets wiped.

## The design

Hoist ownership one level, so the connection lives as long as the **turn**
rather than the **segment**.

1. **`runSession` gains an optional `mcp` parameter** — `{ conns, schemas }`
   already connected by the caller.
2. When supplied: skip `connectAllServers`, skip `releaseMcp`. The session
   *borrows* the connections; it does not own them.
3. When absent: today's behaviour exactly, byte for byte. Every existing caller
   — one-shot, `--issue`, `--resume`, `--parallel`, the bench — is unaffected.
4. **`steerable()` connects once** before its loop and releases once after,
   including on throw and on signal.

```
runSession({ …, mcp })      // borrows: no connect, no release
runSession({ … })           // owns: connect + release, unchanged
```

## ⚠️ The four things that must not break

1. **`--dry-run` / `--no-run` must still stop the spawn.** The gate exists
   because *"cloning a repository that happens to contain a committed
   `.mcp.json` and running `acuvo --dry-run` executed an attacker-chosen binary
   before a single file was read."* Moving the connect UP means the gate moves
   up with it — it cannot be left behind in `runSession`.
2. **MCP servers receive the FULL UNSCRUBBED environment** (`mcp.mjs` does this
   deliberately, because a server needs its credentials). Longer-lived
   connections mean that environment is held longer, so the release path must be
   airtight — including on Ctrl-C, which never reaches a `return`.
3. **Consent is per config fingerprint.** `checkMcpConsent` runs against
   `mcpAsk`; hoisting must not let a second segment inherit consent that was
   granted for a different config.
4. **`liveMcpConns` is the global cleanup registry.** `releaseMcp` removes from
   it; a borrowed connection must be removed exactly once, by its owner, or the
   process holds the event loop open — the same class of bug `repl.mjs` records:
   *"reset → eval → reset hangs forever."*

## Why this is not a five-minute change

Everything above is why it is written down rather than attempted at the end of a
long session. It moves a **security-relevant lifecycle** that already has a
recorded incident, and the failure modes are a leaked credential-bearing child
process or a hung exit — both worse than the defect being fixed.

⭐ **The test that should exist before the change**: a `steerable` turn with two
segments and a fake MCP server that counts spawns. It must be **1**, and today it
is **2**. Write the failing test first; it is the only way to know the fix
worked rather than merely compiled.
