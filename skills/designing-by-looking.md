---
name: designing-by-looking
description: Render it and LOOK — the see_page loop, not better CSS written blind
when: After building or restyling any page, component or app, and before telling anyone it is done
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
