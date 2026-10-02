---
name: finish-the-deliverable
description: Every file the task named must exist and be correct before you stop — exit 0 is not a deliverable
when: At the start, to list what the task asked you to produce; and again before saying done or finished
---

# Finish the deliverable

## ⚠️⚠️ The single largest cause of a zero score is stopping, not failing

MEASURED across **139 real runs** of this CLI on Terminal-Bench 2.1:

| | |
|---|---|
| runs that ended on *"a command passed — stopping here"* | **45** |
| of those 45, how many scored above zero | **0** |
| failing graders whose message was *the output path does not exist* | **64 of 102** |
| runs that never created or edited a single file | **77 of 139 (55%)** |
| runs that used less than half their round budget | **82 of 131** |

⭐ **In a large share of those, the work was done and never written down.** Not
every one of them would have passed — but more than half of all runs produced no
artefact at all, and the most common grader message in the entire corpus is a
missing file, not a wrong answer. That is a failure mode you can fix with a
checklist, which is what this file is.

### The example that makes it concrete

`db-wal-recovery`. The instruction: *"Create a JSON file in `/app/recovered.json`
… recover all 11 records."* The whole transcript is four rounds:

```
$ xxd main.db | head
$ sqlite3 main.db ".tables"
$ sqlite3 main.db "SELECT * FROM items;"        ← the records were on screen
✔ a command passed — stopping here rather than spending another round.
```

Grader: `AssertionError: recovered.json file does not exist`. Every fact needed
to pass was already printed. It was never put in the file that was asked for.

## ⭐ Round one: extract the deliverables before you do anything

Read the brief and pull out every **literal artefact** it names. They are almost
always quoted, pathed or capitalised:

```
DELIVERABLES
  [ ] /app/recovered.json     — JSON, all 11 records, keys as in the schema
  [ ] stdout                  — the count, one integer, nothing else
FORMAT WORDS I MUST OBEY
  "all"  "each"  "one per line"  "sorted"  "JSON"
```

Anything with a path or a filename is a deliverable. So is "print", "output",
"return", "save", "write" followed by a noun. Put this list in your first reply
so it is visible for the rest of the run.

## ⚠️ A command exiting 0 is not evidence of completion

`SELECT * FROM items;` succeeding proves the database is readable. It proves
nothing about a file that does not exist. The completion signal fires on a
command that passed, and **a read-only command passing is the most common thing
that triggers it wrongly.**

Ask, before you emit anything that reads as done:

1. Which path was I asked to create? Does `ls -l` show it, with a non-zero size?
2. Does its content match the FORMAT WORDS — not just the topic?
3. Is there a second deliverable I have stopped thinking about?

## ⚠️⚠️ "all", "every", "each" is an enumeration requirement

`chess-best-move`: *"If there are multiple winning moves, print them all."* The
run had **100 rounds available and used 6.** It reasoned to a single move —
*"Given the ambiguity, the strongest and most likely intended move is…"* — and
wrote 5 bytes.

```
assert ['e2e4'] == ['e2e4', 'g2g4']   # Right contains one more item: 'g2g4'
```

⭐ **When a domain solver exists, install it and run it.** A chess engine, a SAT
solver, a real parser, the library that already does this. An answer you reasoned
to must be re-derived programmatically before you write it down — and an
instruction to list them all requires an explicit enumeration step, not a best
guess. See `shell-and-toolchain` for installing it without blocking.

## ⭐ Leftover budget is not a virtue

82 of 131 runs stopped before spending half their rounds, and stopping early has
never once been the reason a run passed. Rounds are there to be used. If the
deliverable list has an unticked box, you are not finished, however many
commands have gone green.

⚠️ The opposite failure is real too and it looks nothing like this one: retrying
the identical failing command forever. Both are answered by the checklist —
progress is a box ticked, not a round spent.

## The verification pass, which is one round

Before the last message, in one command:

```sh
ls -l /app/recovered.json && head -c 400 /app/recovered.json && python3 -c "
import json; d=json.load(open('/app/recovered.json')); print(type(d), len(d))"
```

That checks three things the grader checks: it exists, it is not empty, and it
parses as the format that was asked for. ⚠️ **A file that exists and holds `{}`
scores exactly the same as no file.**

## Then say what you did and did not do

Name each deliverable, whether it exists, and how you confirmed it. If one is
incomplete, say which and why — an honest partial is useful and an implied
"all done" that turns out to be half is not. See `verify-your-own-work`.

Related: `verify-your-own-work` (proving a change works),
`shell-and-toolchain` (why the round was lost before you got here),
`planning-and-delegating` (tracking more than one deliverable).
