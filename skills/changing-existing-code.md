---
name: changing-existing-code
description: Make exactly the changes asked and nothing else, and never rewrite a file to change part of it
when: An edit to something that already works — change, update, swap, move or add, nothing else
---

# Changing existing code

The hardest thing this agent does is not building a page. It is being handed a
working page and asked to change five things about it.

## ⚠️⚠️ The measured failure: the markup survives and the JavaScript does not

MEASURED on our own bench, 2026-08-29. A working landing page was given the
brief *"Make exactly these five changes and nothing else … Do not restyle or
rewrite anything I did not list."*

| | before | after |
|---|---|---|
| file size | 54,703 chars | 33,890 chars |
| `addEventListener` | 3 | **0** |
| `<form>` | 1 | **0** |
| the page's own `<script>` | 2,804 chars | **0** |

Two of the five edits landed. The contact form, the FAQ accordion and every
event listener were deleted, and **the HTML for them was still there** — so the
page looked almost right and did nothing. Score: 4 of 9. The agentic path scored
3 of 9 after 14 attempts and 520 seconds; the single-shot path failed outright
with *"the edit kept removing the page's own JavaScript, so nothing was saved."*

⚠️ **And it is intermittent, which is why one clean run proves nothing.**
Three consecutive attempts on the same brief: 4,584 → 0 chars, then 3,513 → 0,
then 3,841 → 3,841 (clean). **Two failures in three.** If you change a file and
it happens to survive, you have learned nothing about the next one.

## ⭐ Why it is always the script that dies

The deleted region is at the **end** of the document, every time, and markup
that precedes it is intact. That is the signature of a truncated re-emission,
not of a reasoning error: the model was asked to change an accent colour and
chose to reprint 55,000 characters, and the output ran out before the tail —
where `<script>` lives — was reached.

⭐ **So the fix is not "be more careful". It is: do not reprint the file.**
Output is the half of a build that no cache reaches, and a full-file rewrite to
change one word is the most expensive and least reliable way to make a small
change.

## The procedure

### 1. Fingerprint the file BEFORE you touch it

Three counts, one command, ten seconds. They are the only thing that can later
tell you whether you broke something you were not looking at.

```
search_text  "addEventListener"     → count
search_text  "<form|<script|function "  → count
read_file / ls -l                   → byte size
```

Write the three numbers down in your reply. They are the baseline.

### 2. Turn the brief into two lists, not one

```
CHANGE   1. hero → full-bleed background video with dark overlay
         2. testimonials section above services
         3. sticky header, fades in after 200px
         4. every copper accent → teal
         5. dismissible cookie banner
KEEP     the phone number 02 6100 4477 · the business name · the FAQ accordion
         and the fact that it opens · the contact form and its validation ·
         the three service cards · every existing click handler
```

⭐ **The KEEP list is the one that gets skipped and the one that is scored.**
Three of the nine points in that bench are regression checks: named literals
survive, unmentioned sections survive, behaviours present before are present
after. Build the KEEP list from what you actually see in the file, not from
what the brief mentions — the brief mentions nothing you are supposed to keep.

### 3. Edit by anchor, never by rewrite

For each item on the CHANGE list, find the smallest unique string that locates
it and replace only that.

- A colour swap is `search_text "#B87333"` then one replacement per hit — not a
  new stylesheet.
- Moving a section is cutting one block and pasting it — not regenerating both.
- Adding a cookie banner is an insert before `</body>` plus one CSS rule.

⚠️ If an anchor is not unique the edit will fail or hit the wrong place. Make it
unique by including a neighbouring line, rather than by rewriting the region.

⚠️ **The moment you find yourself about to emit the whole file, stop.** That is
the failure above, in progress. If the change genuinely is structural, do it in
several anchored edits instead, and re-check between them.

### 4. Re-run the fingerprint and compare

```
counts before:  bytes 54,703 · listeners 3 · forms 1 · scripts 2
counts after:   bytes 33,890 · listeners 0 · forms 0 · scripts 1
```

⚠️⚠️ **Any count that went DOWN and is not on the CHANGE list is a regression.**
Not a style question, not something to explain — restore the previous version
and redo the change as anchored edits. Bytes falling by a third when the brief
added two features is the loudest possible signal and it was ignored in every
one of the failing runs.

### 5. Open it and use the parts you did not touch

The counts catch deletion. They do not catch an edit that leaves a listener
bound to an element you renamed. Click the accordion. Submit the form. Press the
key that used to work. See `check-the-site-you-built`.

## ⚠️ "While I was in there" is how you lose the customer's trust

The research this bench was built from found that **all three** competing
products *"occasionally regressed working features on an unrelated prompt."*
That is the reputation-level bug in this category. A tidy-up nobody asked for,
shipped inside an edit they did ask for, is indistinguishable from a bug — and
it arrives without the warning a bug would have had.

If you can see something genuinely wrong that is out of scope, **say it in one
sentence and leave it alone.**

## The five-minute version

1. Count listeners, forms, scripts and bytes. Write them down.
2. Write CHANGE and KEEP as two explicit lists.
3. Anchored edits only. Never reprint the file to change part of it.
4. Re-count. Anything down that was not on CHANGE = restore and retry.
5. Exercise the untouched features in a browser before saying done.

Related: `refactoring` (restructuring without behaviour change),
`verify-your-own-work` (proving a check can fail),
`incremental-implementation` (one slice at a time).
