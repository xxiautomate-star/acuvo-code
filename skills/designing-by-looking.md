---
name: designing-by-looking
description: Design judgement and the see_page loop — plan it, audit the plan for defaults, then render it and LOOK
when: Before choosing a palette or layout, and after building or restyling any page, component or app
---

# Designing By Looking

## ⚠️⚠️ You cannot judge a page you have not seen

You have `see_page`. It renders an HTML file in a real browser and returns a
screenshot **plus measured problems** — invisible text, overflow, cramped
sections. Use it.

**A page you have not looked at is not finished, it is only written.** Markup
that reads correctly is routinely broken on screen: white text on white,
a section 500px tall holding one line, a row that overflows on the narrow
viewport, a delete button stretched across the full width.

Those are the exact defects that shipped in real builds here. Every one of them
is invisible in the source and obvious in a screenshot.

## ⭐⭐ Before the loop: decide what you are aiming at, then audit that decision

Looking tells you whether a page is broken. It does not, on its own, tell you
whether it is *good* — you can loop ten times on a page that works perfectly and
still looks like every other generated page. That is decided before the first
line of CSS.

### The plan is four lines, and it takes a minute

Write it out before building:

1. **4–6 named hex values** and what each is for (paper, ink, accent, line).
2. **Type roles** — the display face, the text face, and the one size that
   dominates.
3. **A one-sentence layout concept.** *"A wide left column of prose with the
   numbers pinned in a narrow right rail."*
4. **What the design is saying.** Fast? Careful? Expensive? Playful?

### ⭐⭐ Then audit it once, with one question

> **"Would I have produced this exact plan for any other brief?"**

If yes, it is not a design, it is a default — and defaults are what make output
read as generated. Change the generic parts and only the generic parts.

⚠️ **The tells, all of which are defaults rather than decisions:** slate
`#0f172a` and indigo; Inter for everything; a centred hero over three equal
cards; rounded corners and a soft shadow on every surface; a purple-to-blue
gradient; emoji standing in for icons; "Empower your workflow" as a headline.
Any two of those together and the page has no point of view.

**Revising is concrete, not vague.** *"A recap of terminal releases"* → near-black
green paper, phosphor text, one amber accent, a mono face, and the layout
following the release timeline rather than a card grid. Same content, and now it
could not be any other page.

### ⭐ Structure must encode something true

Every structural device is a claim, and a false claim is noise:

- Numbered steps (01 / 02 / 03) **only when the order actually matters.**
- Eyebrow labels **only when they classify** something into a real group.
- Dividers **only at genuine seams**, not every 200px.
- A card **only when the contents are a unit** you could pick up and move.
- An icon **only when it means something** — decorative icons are visual noise
  wearing a uniform.

⭐ And precedence when they conflict: **the user's stated wishes first, then the
project's existing design system** (its tokens, its component styles, whatever
is already on screen), then your own taste. Check for existing tokens before
inventing a palette — a "better" palette that matches nothing around it is worse.

*(Plan-then-audit heuristic adapted from nicobailon/visual-explainer, MIT — see
`LICENSE-visual-explainer`.)*

## ⭐⭐ The loop, in order

1. **Build** the page.
2. **`see_page`** on the file you just wrote.
3. **Read the findings first, then look at the screenshot.** The findings are
   measured; your impression is not.
4. **Fix the specific thing.** One at a time.
5. **Look again.** A fix you did not re-check is a hope.

⭐ **Repeat until the screenshot is good, not until the code looks right.** The
loop is the method. Better prompts are not the method — a page improves because
someone looked at it, noticed a real defect, and fixed that defect.

## ⚠️ Do not fix blind

The failure mode is reading your own CSS, forming a theory about what it must
look like, and rewriting it without rendering. That is how a "fix" makes the
page worse and nobody notices for three rounds.

If `see_page` reports overflow, you do not need a theory about why. Look at the
screenshot, find the element that is too wide, and constrain that element.

## ⭐ What to actually check when you look

Ask these in this order, because they fail in this order:

1. **Is every piece of text visible?** Contrast, and not clipped.
2. **Does anything overflow?** Especially tables, code blocks, long words and
   button rows.
3. **Is there dead space?** A section far taller than its content reads as
   broken, not airy.
4. **Is there ONE clear first thing to look at?** If everything is the same
   weight, nothing is.
5. **Do the controls look like controls?** A full-width bar is not a button.
6. **Is there a real `<h1>`?** Pages ship without one constantly.

## ⭐ `read_image` for anything you generated

`see_page` is for pages. For an image you made with `generate_image`, use
**`read_image`** — it returns a factual description, and you can ask it a
question about the file.

**Generating an image and never looking at it is the same mistake as shipping an
unrendered page.** Text inside generated images is misspelled often enough that
it must be checked every time, not assumed.

## ⚠️ Looking costs tokens — so look deliberately, not constantly

A screenshot is charged as image tokens (roughly one token per 750 pixels, with
the long edge capped at 1568). That is cheap, but it is not free.

⭐ **Look after a meaningful change, not after every line.** Build the whole
page, then look. Fix the three findings, then look again. Two or three passes
usually settles a page; ten means you are guessing between them.

## The bar

Not "does this render". The bar is: **does it look like someone designed it,
or does it look like a template with content dropped in?**

Related skills: `acuvo-design-system`, `page-composition`, `typography`,
`colour-and-contrast`, `verify-your-own-work`.
