---
name: code-simplification
description: Cut complexity without changing behaviour — nesting, long functions, unclear names, dead branches
when: Use when code works but is harder to read, maintain or extend than it should be.
---

<!-- Vendored from addyosmani/agent-skills (MIT, (c) 2025 Addy Osmani).
     Licence text: skills/LICENSE-agent-skills. Reformatted from that
     repo's SKILL.md-per-directory layout into this shelf's flat one,
     and CONDENSED to fit the per-read budget: worked examples that
     teach the same point twice collapsed to one. The instructions are
     unchanged. -->


# Code Simplification

> Inspired by the [Claude Code Simplifier plugin](https://github.com/anthropics/claude-plugins-official/blob/main/plugins/code-simplifier/agents/code-simplifier.md). Adapted here as a model-agnostic, process-driven skill for any AI coding agent.

## Overview

Simplify code by reducing complexity while preserving exact behavior. The goal is not fewer lines — it's code that is easier to read, understand, modify, and debug. Every simplification must pass a simple test: "Would a new team member understand this faster than the original?"

## When to Use

After a feature works and tests pass but the implementation feels heavier than it needs to be; when review flags readability; when you hit deep nesting, long functions or unclear names; when refactoring code written under time pressure; when consolidating logic scattered across files; after a merge introduced duplication.

**When NOT to use:** the code is already clean; you don't yet understand what it does (comprehend first); it is performance-critical and the "simpler" version is measurably slower; you are about to rewrite the module entirely.

## The Five Principles

### 1. Preserve Behavior Exactly

Don't change what the code does — only how it expresses it. Inputs, outputs, side effects, error behavior and edge cases must stay identical. If you're not sure a simplification preserves behavior, don't make it. Ask every time: same output for every input? Same error behavior? Same side effects *and ordering*? Do all existing tests still pass **without modification**?

### 2. Follow Project Conventions

Simplification means making code more consistent with the codebase, not imposing external preferences. Read CLAUDE.md / the project conventions, study how neighbouring code handles similar patterns, and match its import ordering and module system, function declaration style, naming, error handling and type-annotation depth. Simplification that breaks project consistency is not simplification — it's churn.

### 3. Prefer Clarity Over Cleverness

Explicit code is better than compact code when the compact version requires a mental pause to parse.

```typescript
// UNCLEAR: dense ternary chain
const label = isNew ? 'New' : isUpdated ? 'Updated' : isArchived ? 'Archived' : 'Active';
// CLEAR: readable mapping
function getStatusLabel(item: Item): string {
  if (item.isNew) return 'New';
  if (item.isUpdated) return 'Updated';
  if (item.isArchived) return 'Archived';
  return 'Active';
}

// UNCLEAR: chained reduce with inline spread; CLEAR: a named intermediate step
// items.reduce((acc, i) => ({ ...acc, [i.id]: { count: (acc[i.id]?.count ?? 0) + 1 } }), {})
const countById = new Map<string, number>();
for (const i of items) countById.set(i.id, (countById.get(i.id) ?? 0) + 1);
```

### 4. Maintain Balance

Simplification has a failure mode: over-simplification. The traps:

- **Inlining too aggressively** — removing a helper that gave a concept a name makes the call site harder to read
- **Combining unrelated logic** — two simple functions merged into one complex one is not simpler
- **Removing "unnecessary" abstraction** — some exist for extensibility or testability, not complexity
- **Optimizing for line count** — fewer lines is not the goal; easier comprehension is

### 5. Scope to What Changed

Default to simplifying recently modified code. Avoid drive-by refactors of unrelated code unless explicitly asked to broaden scope. Unscoped simplification creates noise in diffs and risks unintended regressions.

## The Simplification Process

### Step 1: Understand Before Touching (Chesterton's Fence)

Before changing or removing anything, understand why it exists. If you see a fence across a road and don't understand why it's there, don't tear it down: first understand the reason, then decide if the reason still applies.

Answer first: what is this code's responsibility? What calls it and what does it call? What are the edge cases and error paths? Do tests define the expected behavior? Why might it have been written this way — performance, a platform constraint, history? What does `git blame` say? If you can't answer these, read more context first.

### Step 2: Identify Simplification Opportunities

Scan for these patterns — each one is a concrete signal, not a vague smell:

**Structural complexity:**

| Pattern | Signal | Simplification |
|---|---|---|
| Deep nesting (3+ levels) | Hard to follow control flow | Guard clauses or helper functions |
| Long functions (50+ lines) | Multiple responsibilities | Split into focused, descriptively named functions |
| Nested ternaries | Needs a mental stack to parse | if/else chains, switch, or lookup objects |
| Boolean parameter flags | `doThing(true, false, true)` | Options objects or separate functions |
| Repeated conditionals | Same `if` in several places | A well-named predicate function |

**Naming and readability:**

| Pattern | Signal | Simplification |
|---|---|---|
| Generic names | `data`, `result`, `temp`, `val` | Name the content: `userProfile`, `validationErrors` |
| Abbreviated names | `usr`, `cfg`, `btn`, `evt` | Full words unless universal (`id`, `url`, `api`) |
| Misleading names | A `get` that also mutates | Rename to reflect actual behavior |
| Comments explaining "what" | `// increment counter` on `count++` | Delete it — the code is clear enough |
| Comments explaining "why" | `// Retry: the API is flaky under load` | **Keep** — intent the code can't express |

**Redundancy:**

| Pattern | Signal | Simplification |
|---|---|---|
| Duplicated logic | Same 5+ lines in several places | Extract to a shared function |
| Dead code | Unreachable branches, unused vars, commented-out blocks | Remove, once confirmed truly dead |
| Unnecessary abstractions | A wrapper that adds no value | Inline it; call the underlying function |
| Over-engineered patterns | Factory-for-a-factory, strategy-with-one | The simple direct approach |
| Redundant type assertions | Casting to an already-inferred type | Remove the assertion |

### Step 3: Apply Changes Incrementally

One simplification at a time: change → run the suite → pass, commit or continue; fail, revert and reconsider. Never batch several into one untested change — when something breaks you need to know which one did it. **Submit refactoring separately from feature or bug-fix changes:** a PR that refactors *and* adds a feature is two PRs.

**The Rule of 500:** if a refactoring would touch more than 500 lines, automate it (codemods, sed, AST transforms). Manual changes at that scale are error-prone and exhausting to review.

### Step 4: Verify the Result

Compare before and after: is it genuinely easier to understand? Did you introduce patterns inconsistent with the codebase? Is the diff clean and reviewable? Would a teammate approve it? If the "simplified" version is harder to read or review, revert — not every attempt succeeds.

## Language-Specific Guidance

```typescript
// TS/JS — drop the unnecessary async wrapper; return the promise
async function getUser(id) { return await userService.findById(id); }  // before
function getUser(id: string): Promise<User> { return userService.findById(id); }

// TS/JS — manual array building → filter
const active: User[] = []; for (const u of users) { if (u.isActive) active.push(u); }
const active = users.filter((u) => u.isActive);

// TS/JS — redundant boolean return
function isValid(s) { if (s.length > 0 && s.length < 100) return true; return false; }
function isValid(s: string) { return s.length > 0 && s.length < 100; }
```

```python
# Python — nested conditionals become early returns (the highest-value one)
def process(data):                      # before
    if data is not None:
        if data.is_valid():
            if data.has_permission(): return do_work(data)
            else: raise PermissionError("No permission")
        else: raise ValueError("Invalid data")
    else: raise TypeError("Data is None")

def process(data):                      # after
    if data is None: raise TypeError("Data is None")
    if not data.is_valid(): raise ValueError("Invalid data")
    if not data.has_permission(): raise PermissionError("No permission")
    return do_work(data)

# Python — verbose dict building → comprehension
result = {item.id: item.name for item in items}
```

```tsx
// React — verbose conditional rendering: lift the varying values, return once
function UserBadge({ user }: Props) {
  const variant = user.isAdmin ? 'admin' : 'default';
  return <Badge variant={variant}>{user.isAdmin ? 'Admin' : 'User'}</Badge>;
}
// React — prop drilling through intermediate components: context or composition may
// be better, but this is a judgment call. FLAG IT, do not auto-refactor.
```

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "It's working, no need to touch it" | Working code that's hard to read is hard to fix when it breaks. Simplifying now saves time on every future change. |
| "Fewer lines is always simpler" | A 1-line nested ternary is not simpler than a 5-line if/else. Simplicity is comprehension speed, not line count. |
| "I'll quickly simplify this unrelated code too" | Unscoped simplification creates noisy diffs and risks regressions in code you didn't intend to change. |
| "The types make it self-documenting" | Types document structure, not intent. A well-named function explains *why* better than a type explains *what*. |
| "This abstraction might be useful later" | Don't preserve speculative abstractions. Unused now = complexity without value. Re-add when needed. |
| "The original author must have had a reason" | Maybe — check git blame, apply Chesterton's Fence. But accumulated complexity is often just the residue of iteration under pressure. |
| "I'll refactor while adding this feature" | Separate refactoring from feature work. Mixed changes are harder to review, revert and understand. |

## Red Flags

Simplification that requires modifying tests to pass (you likely changed behavior) · "simplified" code that is longer and harder to follow · renaming to your own preferences rather than project conventions · removing error handling because "it makes the code cleaner" · simplifying code you don't fully understand · batching many simplifications into one hard-to-review commit · refactoring outside the current task without being asked.

## Verification

After completing a simplification pass:

- [ ] All existing tests pass **without modification**
- [ ] Build succeeds with no new warnings; linter/formatter passes
- [ ] Each simplification is a reviewable, incremental change
- [ ] The diff is clean — no unrelated changes mixed in
- [ ] It follows project conventions (checked against CLAUDE.md or equivalent)
- [ ] No error handling was removed or weakened
- [ ] No dead code left behind (unused imports, unreachable branches)
- [ ] A teammate would approve it as a net improvement
