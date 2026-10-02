---
name: git-workflow-and-versioning
description: Commits as save points — trunk-based branching, conflict resolution, semantic versions, tags, changelogs
when: Committing, branching, resolving conflicts, cutting a release, tagging, or writing a changelog
---

<!-- Vendored from addyosmani/agent-skills (MIT, (c) 2025 Addy Osmani).
     Licence text: skills/LICENSE-agent-skills. Reformatted from that
     repo's SKILL.md-per-directory layout into this shelf's flat one,
     and CONDENSED to fit the per-read budget: ASCII diagrams that
     restate their own prose collapsed, and four cross-references to
     skills that do not exist on this shelf repointed or removed.
     The instructions are unchanged. -->


# Git Workflow and Versioning

## Overview

Git is your safety net. Treat commits as save points, branches as sandboxes, and history as documentation. With AI agents generating code at high speed, disciplined version control is what keeps changes manageable, reviewable and reversible. It applies always: every code change flows through git.

## Core Principles

### Trunk-Based Development (Recommended)

Keep `main` always deployable. Work in short-lived feature branches that merge back within 1-3 days. Long-lived development branches are hidden costs — they diverge, create merge conflicts, and delay integration. DORA research consistently shows trunk-based development correlates with high-performing teams. Teams on gitflow can adapt the principles (atomic commits, small changes, descriptive messages) to their model — the commit discipline matters more than the branching strategy.

- **Dev branches are costs.** Every day a branch lives, it accumulates merge risk.
- **Release branches are acceptable.** When you need to stabilize a release while main moves forward.
- **Feature flags > long branches.** Prefer deploying incomplete work behind flags rather than keeping it on a branch for weeks.

### 1. Commit Early, Commit Often

Each successful increment gets its own commit: implement a slice → test → verify → commit → next slice. Not: implement everything → hope it works → one giant commit. Commits are save points; if the next change breaks something you can revert to the last known-good state instantly.

### 2. Atomic Commits

Each commit does one logical thing.

```
# Good: each commit is self-contained
a1b2c3d Add task creation endpoint with validation
d4e5f6g Add task creation form component
h7i8j9k Connect form to API and add loading state
# Bad: everything mixed together
x1y2z3a Add task feature, fix sidebar, update deps, refactor utils
```

### 3. Descriptive Messages

Commit messages explain the *why*, not just the *what*:

```
# Good: explains intent          # Bad: obvious from the diff
feat: add email validation to    update auth.ts
      registration endpoint

Prevents invalid email formats reaching the database. Uses Zod at the
route handler level, consistent with existing patterns in auth.ts.
```

**Format:** `<type>: <short description>`, then an optional body explaining why, not what.

**Types:** `feat` (new feature) · `fix` (bug fix) · `refactor` (neither fixes a bug nor adds a feature) · `test` · `docs` · `chore` (tooling, dependencies, config).

### 4. Keep Concerns Separate

Don't combine formatting changes with behavior changes, or refactors with features. Each type of change is a separate commit and ideally a separate PR — `refactor: extract validation logic to shared utility` and `feat: add phone number validation to registration`, never `refactor validation and add phone number field`.

**Separate refactoring from feature work.** They are two different changes; submitting them separately makes each easier to review, revert, and understand in history. Small cleanups (renaming a variable) can ride along in a feature commit at reviewer discretion.

### 5. Size Your Changes

Target ~100 lines per commit/PR — easy to review, easy to revert. ~300 lines is acceptable for a single logical change. Anything over ~1000 lines should be split before submitting.

## Branching Strategy

One feature per branch, branched from `main` (or the team's default): `feature/task-creation`, `feature/user-settings`, `fix/duplicate-tasks`. Naming is `feature/` · `fix/` · `chore/` · `refactor/` plus a short description.

- Keep branches short-lived (merge within 1-3 days) — long-lived branches are hidden costs
- Delete branches after merge
- Prefer feature flags over long-lived branches for incomplete features

## Working with Worktrees

For parallel AI agent work, run multiple branches simultaneously. Each worktree is a separate directory with its own branch, so agents work in parallel without branch switching and without interfering; if one experiment fails, delete the worktree and nothing is lost.

```bash
git worktree add ../project-feature-a feature/task-creation
git worktree remove ../project-feature-a   # when merged
```

## The Save Point Pattern

After every change: test passes → commit → continue. Test fails → revert to the last commit → investigate. You never lose more than one increment of work, and if an agent goes off the rails `git reset --hard HEAD` returns you to the last successful state. When the feature is complete, the commits already form a clean history.

## Change Summaries

After any modification, provide a structured summary. It makes review easier, documents scope discipline, and surfaces unintended changes:

```
CHANGES MADE:
- src/routes/tasks.ts: Added validation middleware to POST endpoint
THINGS I DIDN'T TOUCH (intentionally):
- src/routes/auth.ts: Has similar validation gap but out of scope
POTENTIAL CONCERNS:
- The Zod schema is strict — rejects extra fields. Confirm this is desired.
```

The "DIDN'T TOUCH" section is the important one: it shows you exercised scope discipline and didn't go on an unsolicited renovation, and it catches wrong assumptions early.

## Pre-Commit Hygiene

Before every commit: read `git diff --staged`; check it for secrets
(`git diff --staged | grep -i "password\|secret\|api_key\|token"`); run the
tests; run the linter; run type checking (`npx tsc --noEmit`). Automate it with
git hooks — e.g. `lint-staged` + `husky`, `"*.{ts,tsx}": ["eslint --fix", "prettier --write"]`.

## Handling Generated Files

- **Commit generated files** only if the project expects them (e.g. `package-lock.json`, Prisma migrations)
- **Don't commit** build output (`dist/`, `.next/`), environment files (`.env`), or IDE config (`.vscode/settings.json` unless shared)
- **Have a `.gitignore`** covering `node_modules/`, `dist/`, `.env`, `.env.local`, `*.pem`

## Using Git for Debugging

```bash
git bisect start; git bisect bad HEAD; git bisect good <known-good-commit>
#   git checks out midpoints; run your test at each to narrow it down
git log --oneline -20                 # what changed recently
git diff HEAD~5..HEAD -- src/
git blame src/services/task.ts        # who last changed a line
git log --grep="validation" --oneline # search commit messages
```

## Release & Versioning

Commits are how *you* track change; a **version** is how your *consumers* track it. The moment anything else depends on your code — another team, a published package, a deployed client — "latest on main" stops being a sufficient answer to "what am I running, and is it safe to upgrade?" A version number and a changelog are the contract that answers it.

### Semantic Versioning

For anything with consumers, version `MAJOR.MINOR.PATCH` and let the number carry meaning: **MAJOR** = breaking, consumers must change their code; **MINOR** = new functionality, backward-compatible, safe to upgrade; **PATCH** = bug fix, backward-compatible, safe to upgrade.

The number is a promise, so make the code match it. A "patch" that changes behavior consumers relied on is a major change wearing a disguise (Hyrum's Law — see `api-design`). When unsure whether a change is breaking, assume it is; a surprise major is far cheaper than a broken consumer.

### Tag the release, and let the tag be the source of truth

A release is an immutable point in history, not a moving branch. Tag it so it can always be reproduced:

```bash
git tag -a v1.4.0 -m "Release 1.4.0"
git push origin v1.4.0
```

Derive the version from the tag rather than hand-editing it in scattered files, so the artifact, the tag, and the changelog can never disagree.

### Keep a changelog written for humans

A changelog is not `git log`. It's the curated, consumer-facing answer to "what changed and do I care?" — grouped by `Added / Changed / Fixed / Deprecated / Removed / Security`, newest on top, every entry phrased around user impact, not internal mechanics.

```markdown
## [1.4.0] - 2025-06-12
### Added
- Bulk task import via CSV
### Fixed
- Timezone drift in recurring task due dates
### Deprecated
- `GET /v1/tasks/all` — use the paginated `GET /v1/tasks` (removal in 2.0)
```

Write the entry in the same change that makes the change, while the impact is fresh — not reconstructed from commit archaeology at release time. Breaking changes get a migration note and a deprecation window. Shipping the actual release is `ship-it`'s job; this section is the versioning contract that feeds it.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "I'll commit when the feature is done" | One giant commit is impossible to review, debug or revert. Commit each slice. |
| "The message doesn't matter" | Messages are documentation. Future you (and future agents) need to know what changed and why. |
| "I'll squash it all later" | Squashing destroys the development narrative. Prefer clean incremental commits from the start. |
| "Branches add overhead" | Short-lived branches are free and stop conflicting work colliding. Long-lived ones are the problem — merge within 1-3 days. |
| "I'll split this change later" | Large changes are harder to review, riskier to deploy, harder to revert. Split before submitting. |
| "I don't need a .gitignore" | Until `.env` with production secrets gets committed. Set it up immediately. |
| "It's just a small fix, bump the patch" | Check what consumers can observe. A behavior change they relied on is a major, whatever the diff size. |
| "The changelog is just the commit log" | Commits are for you; the changelog is for consumers, curated by impact. |
| "We'll write the changelog at release time" | By then the impact is reconstructed from memory and half of it is missing. Write it with the change. |

## Red Flags

Large uncommitted changes accumulating · messages like "fix", "update", "misc" · long-lived branches diverging from main · force-pushing a shared branch · a release with no tag, or a version hand-edited out of sync with it.

## Verification

For every commit:

- [ ] Commit does one logical thing
- [ ] Message explains the why, follows type conventions
- [ ] Tests pass before committing
- [ ] No secrets in the diff
- [ ] No formatting-only changes mixed with behavior changes
- [ ] `.gitignore` covers standard exclusions

For every release (anything with consumers):

- [ ] The version bump matches the change: breaking → major, additive → minor, fix → patch
- [ ] The release is tagged, and the version is derived from the tag, not hand-edited out of sync
- [ ] The changelog has a curated, human-readable entry grouped by impact for this version
