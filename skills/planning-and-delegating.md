---
name: planning-and-delegating
description: Multi-deliverable work — declare the plan, track it honestly, delegate to save context
when: More than one deliverable, a command the user says must pass, or a subtask that would flood context
---

# Planning And Delegating

## ⭐⭐ Declare the deliverables BEFORE starting

`plan_start` records what a task's deliverables are. Every later tool result
then carries a line telling you how many remain.

**Why it matters more than it looks:** the common failure on a five-part request
is not doing a part badly, it is **finishing three and reporting done.** A plan
you cannot see is a plan you will drift off. The reminder rides along with work
you were doing anyway.

Use it whenever the request has more than one deliverable — *"add the endpoint,
write the test, and update the docs"* is three, not one.

## ⚠️⚠️ `plan_step` done means the deliverable EXISTS and you CHECKED

Marking a step done because you wrote the code that should produce it is how a
plan becomes fiction. **Nothing else marks a step done** — so if the plan says
done, that is a claim you made, and the user will read it as verified.

`blocked` is a real state and an honest one. Use it. A blocked step that says so
is worth far more than a done step that is not.

⭐ **`plan_status` when you have lost the thread** — after a long detour, or
resuming. Cheaper than re-reading the conversation, and it is authoritative.

## ⭐⭐⭐ Acceptance criteria are the USER'S words, recorded early

When the user says *"it's done when `npm test` passes"*, call
**`declare_acceptance` with their command, verbatim, ONCE, before doing the
work.**

⚠️ **A criterion chosen AFTER the work is a criterion chosen to pass.** That is
the whole reason it is recorded first — a test you picked because it goes green
proves nothing about what was asked.

**`check_acceptance` is the only thing that clears them.** Running the command
yourself and seeing it pass does not; `evaluate` returning true does not. If the
criteria are outstanding, the work is outstanding, however good the code looks.

## ⭐⭐ `delegate` protects the thing you cannot get back: context

Hand off a self-contained piece of work and you get back **a short summary, not
everything the helper read.** The helper burns its own context; yours stays for
the work only you can do.

**Good delegation:** *"find every call site of `readRows` and report which ones
ignore the status field"* — a big search, a small answer.

⚠️ **Bad delegation:** anything where you need the intermediate detail, or where
the task is not self-contained. The helper cannot see your conversation. If the
brief needs three paragraphs of background, you are better off doing it.

⭐ **It only READS by default.** That is the safe setting and it should stay the
default in your head: send it to find out, come back to decide.

## ⭐⭐ Several sub-tasks at once — `acuvo --parallel`

When the plan has independent deliverables that touch DIFFERENT files (the API
and the tests, the README and the migration), do not run them one after the
other. On a machine with the `acuvo` agent on it:

```sh
acuvo --parallel "add the /api/orders route with validation" "write tests for lib/totals.js" --unattended --yes --max-rounds 6
```

Each task is its own fresh agent with its own context; two run at a time (up to
`--concurrency 4`). The report names what each one changed and, loudly, any file
two of them both wrote — that run is marked conflicted and nothing is silently
lost. So: give each task a disjoint set of files in its wording, and read the
summary before you touch those files yourself. Sequential is the default for a
reason; parallel is for work you have already split.

## ⭐ `remember` for what a future session would otherwise get WRONG

Not a diary. One durable fact, with **why**, and only if a future session would
otherwise repeat a mistake or rediscover something expensive.

*"The dev server needs `npm install` first — `node_modules` ships incomplete"* is
worth remembering. *"Fixed the header"* is not.

Related skills: `plan-before-building`, `verify-your-own-work`, `debugging`.
