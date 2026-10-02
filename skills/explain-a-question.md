---
name: explain-a-question
description: Answering "explain X" or "teach me X" by BUILDING a staged, narrated board with a check-your-understanding walk — never a paragraph
when: The request is a question, a lesson, "how does X work", "teach me", a quiz or flashcards, or anything where a picture would carry the idea
triggers: explain, explain how, walk me through, teach me, lesson, tutorial, learn, quiz, flashcards, study, worked example, step by step, visualise, visualize, diagram it, show me how, whiteboard
version: 2
applies-to: builder
---

# Explain a question — build it, do not write it

A paragraph is the failure mode, however well written. "Explain how X works"
must reach the whole builder: a drawn structure, arriving in order, narrated,
with the one thing that matters pointed at, and a question at the end that
proves it landed. The drawing craft (timing, strokes) is in `sketch-and-explain`.

## The scene — `AcuvoBoard.into(selector, scene)`

```js
const scene = {
  title: 'How a rainbow forms',
  nodes: [
    { id: 'sun', label: 'Sunlight', note: 'all colours together', shape: 'pill' },
    { id: 'drop', label: 'Raindrop', note: 'bends light twice', accent: true },
    { id: 'split', label: 'Colours split', note: 'each bends a different amount' },
    { id: 'eye', label: 'Your eye', note: 'sees each colour from a different drop' },
  ],
  edges: [
    { from: 'sun', to: 'drop', label: 'enters', flow: true },
    { from: 'drop', to: 'split', label: 'refracts' },
    { from: 'split', to: 'eye', label: '42° back' },
  ],
  steps: [
    { show: ['sun'], say: 'Sunlight looks white, but it carries every colour.' },
    { show: ['drop'], focus: 'drop', spotlight: true, say: 'A raindrop bends it on the way in, and again on the way out.' },
    { show: ['split'], say: 'Red bends least and violet most, so the colours fan apart.' },
    { show: ['eye'], say: 'Each colour reaches you from drops at a slightly different height — that is the bow.' },
  ],
  frames: [
    { say: 'Which colour bends the MOST?', options: [
      { label: 'Red', then: 'Red bends least — that is why it sits on the outside.' },
      { label: 'Violet', correct: true, then: 'Yes — violet bends most, so it is on the inside.' },
    ] },
  ],
};
await AcuvoBoard.into('#board', scene);   // `into`, not `render`, so the frames walk is active
```

- `steps` reveal in order; each has `show` (node ids), optional `focus` /
  `spotlight`, and `say` — the narration line.
- `frames` make it click-through: `say` is the question, each option has
  `label`, optional `correct: true`, and `then` (the response).
- `mark` on a node (`circle` · `underline` · `box` · `strike` · `highlight`)
  is the pointing gesture — use it for the one thing the learner must remember.

## ⭐ The shape of a good lesson — check it before drawing

```js
// @selftest — a lesson scene is valid when every reference resolves and the walk can be won
function lessonProblems(scene) {
  const ids = new Set((scene.nodes ?? []).map((n) => n.id));
  const out = [];
  if (!scene.title) out.push('no title');
  if ((scene.nodes ?? []).length > 9) out.push('more than 9 nodes — split it into two boards');
  for (const e of scene.edges ?? []) if (!ids.has(e.from) || !ids.has(e.to)) out.push(`edge ${e.from}->${e.to} names a missing node`);
  for (const [i, s] of (scene.steps ?? []).entries()) {
    for (const id of s.show ?? []) if (!ids.has(id)) out.push(`step ${i + 1} shows missing "${id}"`);
    if (!String(s.say ?? '').trim()) out.push(`step ${i + 1} has no narration`);
  }
  const shown = new Set((scene.steps ?? []).flatMap((s) => s.show ?? []));
  for (const id of ids) if (!shown.has(id)) out.push(`"${id}" is never revealed`);
  for (const [i, f] of (scene.frames ?? []).entries()) {
    const opts = f.options ?? [];
    if (opts.length && opts.filter((o) => o.correct).length !== 1) out.push(`question ${i + 1} needs exactly one correct option`);
    if (opts.some((o) => !o.then)) out.push(`question ${i + 1} has an option with no response`);
  }
  if (!(scene.frames ?? []).length) out.push('no check-your-understanding question');
  return out;
}
const good = {
  title: 'T', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'b' }],
  steps: [{ show: ['a'], say: 'first' }, { show: ['b'], say: 'then' }],
  frames: [{ say: 'Q?', options: [{ label: 'x', correct: true, then: 'yes' }, { label: 'y', then: 'no' }] }],
};
assert.deepEqual(lessonProblems(good), []);
const bad = { ...good, edges: [{ from: 'a', to: 'z' }], steps: [{ show: ['a'], say: '' }], frames: [] };
const p = lessonProblems(bad);
assert.ok(p.includes('edge a->z names a missing node'));
assert.ok(p.includes('step 1 has no narration'));
assert.ok(p.includes('"b" is never revealed'));
assert.ok(p.includes('no check-your-understanding question'));
```

## The rules that make it teach

- **One idea per step.** Four to seven steps. A step that says two things is two steps.
- **Narration is a sentence a teacher would say**, not a label repeated.
- **Colour means "look here".** One `accent` node per board.
- **End with a question** whose wrong answers are the real misconceptions, and
  whose responses explain WHY — "Wrong" alone teaches nothing.
- **The board is a surface, not a page.** No essay on the canvas; if a node
  needs a paragraph, it is two nodes.
- Maths: a `draw` array handles axes, plots and KaTeX; use it rather than
  describing a graph in words.

## Before you finish

`lessonProblems(scene)` returns `[]`, the board draws step by step, and the
question can be answered right AND wrong with a response each way.
