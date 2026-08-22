---
name: plan-before-building
description: Use the planning verbs and the whiteboard to think before writing code
when: Any task with more than about three steps, or any ambiguous request
---

# Think first, then build

## Why this pays

An agent that starts typing immediately rewrites files it already wrote, loses
track of what is done, and produces the same file three times. Planning is not
ceremony — it is what keeps a long build coherent.

Use `plan_start` / `plan_step` / `plan_status`. They exist so the plan survives
the context, not just your intention.

## The shape of a good plan

1. **Restate the goal in one sentence.** If you cannot, you do not have one yet.
2. **List what you do not know** and how you will find out — read a file, run a
   command, check a schema. Do this BEFORE writing code that assumes an answer.
3. **Order by risk, not by ease.** The step most likely to invalidate the others
   goes first. Discovering the API shape after building the UI around it is the
   expensive order.
4. **Name what "done" looks like** in terms someone else could check.

## Read before you write

Before editing a file, read it. Before adding a helper, search for one that
exists. Before designing a schema, look at the tables already there.

Most duplicated code is not a naming failure — it is someone writing before
looking. `list_files` and `search_text` are cheap; a second implementation of an
existing thing is not.

## Use the whiteboard to think, not just to output

A whiteboard or diagram is most valuable BEFORE the code: laying out the screens,
the data flow, the states. Using it only to render a finished result wastes the
half where it actually helps.

Sketch: what are the screens, what data does each need, where does that data come
from, what happens when it is missing.

## When to stop and ask

Ask when two readings of the request produce materially different work and you
cannot tell which is meant. Do not ask about things you can determine yourself by
reading the code — that is slower for everyone and it is your job.

State the assumption and keep moving when the cost of being wrong is low.
