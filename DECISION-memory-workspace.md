# DECISION — `lib/memory-workspace.mjs` stays dark from here, and the owner is `console/`

**Recorded 2026-09-19. Instrument: `scripts/zz-what-is-dark.mjs`.**

`lib/memory-workspace.mjs` is 180 lines, tested, and reached by **no path from
either binary**. It has sat on `KNOWN_UNWIRED` in `test/wiring-reach.test.mjs`
behind one line: *"built for 'one loop, two clients', and the second client is
the console, which does not run this binary."*

## ⚠️ THE EXCUSE WAS AN INTENTION WEARING A FACT'S CLOTHES

The first half is true. The second half reads as *"reached by the other
client"* — and **it is reached by neither.**

Measured: `grep -rn createMemoryExecutor console/` returns exactly one hit, and
it is a **comment** in `console/lib/plan-drift.test.ts` recording that
`acuvo-code` gained an `exports` map on 2026-08-16 *"so the console **could**
reach `createMemoryExecutor`"*. `could` is the whole finding. The channel is
real — the console genuinely imports `acuvo-code/lib/plan.mjs` through that same
map — and nothing has ever imported the executor through it.

## WHY NOTHING IN THIS PACKAGE CAN CLOSE IT

The CLI has a disk. That is what `createLocalExecutor` is for, and the module's
own header says so:

```
CLI      -> createLocalExecutor(dir)      -> real files, child_process
BUILDER  -> createMemoryExecutor({...})   -> a file MAP, Modal sandbox
```

So no amount of work in `acuvo-code/` makes this reachable. The one change that
would is a `createMemoryExecutor` call in the console's builder, where
`turn.mjs`'s write→run→fix loop would meet the generated-files Map — which is
also, per the module header, the diagnosed cause of the peer gap: *"we generate
a PAGE where Manus/Replit/Base44 generate an APPLICATION, and the cause is not
the model — it is that the builder has no write→run→fix loop."*

⛔ **DO NOT** import this module somewhere in `lib/` to turn the dark-module
entry green. An import with no caller is the same defect with the evidence
removed, and `test/wiring-reach.test.mjs`'s allowlist comment says so.

## THE DECISION

**Left dark deliberately, and the fact is now recorded rather than implied.**
This is not a `DECISION-localize-files.md`-style "measured and declined" — the
capability is wanted, the reasoning for it is strong, and the work is simply not
in this package. What was wrong was a guard comment that read as though somebody
had already done it.

**Owner: whoever next works the builder loop in `console/`.** One call site
closes it, and `wiring-reach.test.mjs` will notice the day it does.
