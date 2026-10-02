---
name: creative-engines
description: Image, voice and editing engines — cost first, edit rather than regenerate, check what came back
when: When asked to make, change, reframe or narrate an image or audio, or asked what something will cost
---

# Creative Engines

Acuvo can generate and edit real media. The engines are good; most bad results
come from reaching for the wrong verb, not from the model.

| verb | use it for |
|---|---|
| `list_engines` | what this account can reach, and **what it costs in credits** |
| `generate_image` | a new image from a prompt |
| `edit_image` | change **one thing** in an image that already exists |
| `expand_image` | a new aspect ratio by painting new edges, not cropping |
| `speak` | text to an audio file, in a fixed voice |
| `read_image` | LOOK at what you produced |
| `make_document` | an HTML file → a real PDF, PNG or PPTX |

## ⚠️⚠️ Cost before spending, every time

**`list_engines` before you spend, whenever the user asks what something costs,
asks for "the cheap one", or is about to buy something at volume.** It reports
what this account can actually reach and the credit price of each engine.

Spending someone's credits on an engine they did not choose, at a price they
never saw, is the worst thing you can do here. If a request implies many images,
say the total first.

## ⭐⭐ EDIT beats REGENERATE — almost always

When an image is nearly right, do **not** generate it again. A regeneration
throws away everything that was already good and rerolls the composition, the
lighting and the subject.

**`edit_image` names what to replace in plain words:**
`target: "the sign on the van"` → `replacement: "plain white panel"`.

⭐ This is cheaper, faster, and it *keeps the picture the user already liked*.
"Make the sign blank" is an edit. "Try again but better" is a reroll, and the
user will lose the version they wanted.

Same reasoning for aspect ratio: **`expand_image` paints new edges** to reach
16:9, 9:16 or 4:5. Cropping to reframe throws away the subject; expanding keeps
it and invents only the margins.

## ⚠️ Use the path the result gives you

`generate_image` returns a `.png` **or** a `.jpg` — the extension follows
whatever the engine produced. **Use the exact path from the result.** Do not
assume `.png` and do not construct the filename yourself; a hardcoded extension
is a file-not-found on the next step.

## ⚠️⚠️ `speak` uses a FIXED voice — never offer to clone one

`speak` reads in one fixed voice. **It cannot clone anybody.** Do not offer to
make it sound like the user, like a celebrity, or like anyone named. Leave
`engine` unset unless there is a reason.

Promising a cloned voice from this verb is a promise the tool cannot keep, and
the user finds out only after they have spent credits.

## ⭐ Always look at what came back

**`read_image` on anything you generated**, before you present it. Ask it a
question if you have a specific worry — spelling is the usual one, because text
rendered inside a generated image is wrong often enough that it must be checked
rather than assumed.

Presenting a generated image you have not looked at is presenting a guess. See
the `designing-by-looking` skill — it is the same rule as never shipping an
unrendered page.

## ⭐ A PDF, a deck or a poster: write HTML, then press it

`make_document` takes an **HTML file you already wrote** and returns a real
`.pdf`, `.png` or `.pptx`. It does not take a prompt — the layout is yours, so
everything you know about CSS applies, and `@page` and `page-break-inside: avoid`
work the way they do in a browser's print dialog.

⭐ **From a shell — including a build sandbox — it is one command and no model
turn:**

```
acuvo document report.html report.pdf
```

`.png` and `.pptx` follow from the output extension. It presses the file and
exits, so it costs a command rather than an agent session; `acuvo "turn
report.html into a PDF"` would do the same work and buy a model turn to do it.

⚠️ It needs an account: `acuvo --login`, or `ACUVO_TOKEN` in the environment
(which is how it works inside a build machine), or `MODAL_PRESS_URL` pointing at
your own worker. Without one it refuses and names those three — it never
silently writes nothing.

⚠️ **Look at the result.** A PDF is not a screenshot of your intent: the page box
is a different shape from a viewport, so anything positioned with `vh`, anything
relying on scroll, and anything in a fixed-height container will land somewhere
you did not expect. Press it, open it, then present it.

## ⭐ Choosing size

Ask what the image is FOR before picking dimensions: a hero is wide, a post is
square or 4:5, a story is 9:16. Generating square and cropping later loses the
subject; generating at the right shape, or expanding to it, does not.

Related skills: `designing-by-looking`, `acuvo-design-system`.
