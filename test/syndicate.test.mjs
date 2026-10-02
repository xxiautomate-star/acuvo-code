/**
 * ── syndicate — ONE IDEA, EVERY FORMAT IT HAS TO EXIST IN ───────────────────
 *
 * ⚠️⚠️ NOTHING IN THIS FILE GENERATES ANYTHING, AND THAT IS NOT A TESTING
 * TRICK — IT IS THE VERB'S DESIGN. `syndicate` calls no model, no GPU and no
 * network by construction: the caller composes the copy and the verb assembles
 * it. So there is no producer to inject, no mock to drift, and every assertion
 * below runs the REAL code path onto a REAL temporary directory for free.
 *
 * ⭐ THE ASSERTIONS THAT MATTER MOST ARE THE ARITHMETIC ONES. "Does the blog
 * read well" is not this file's business and never could be. "Is post 4 of 9
 * over 280 characters ONCE THE COUNTER IS APPENDED" is the defect that ships,
 * and it is checked here from both sides.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  syndicate, syndicateToolSchemas, syndicateToolNames, runSyndicateTool,
  slugify, charCount, wordCount, yamlScalar, splitPost,
  buildThread, renderThread, renderBlog, renderInfographic, wrapLabel,
  PLATFORM_LIMITS, MAX_THREAD_POSTS, SYNDICATE_TOOL_NAMES,
} from '../lib/syndicate.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';
import { TOOL_NAMES, toolNamesForRounds, executeToolCall } from '../lib/tools.mjs';
import { REFUSED_TOOL_REASONS } from '../lib/mcp-server.mjs';

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-syndicate-'));
  t.after(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* windows handle lag */ } });
  return root;
}

const FIXED = new Date('2026-08-25T02:00:00Z');

const IDEA = 'Why we price per outcome';
const BLOG = {
  title: 'Why we price per outcome: the whole argument',
  dek: 'Seats measure attendance. Outcomes measure work.',
  tags: ['pricing', 'saas'],
  sections: [
    { heading: 'The problem with seats', body: 'A seat is a proxy for value and a bad one. It rewards headcount growth and punishes automation.' },
    { heading: 'What we changed', body: 'We bill per confirmed booking. If nothing is booked, nothing is billed.' },
  ],
};
const THREAD = {
  platform: 'x',
  posts: [
    'Seat pricing rewards the wrong thing: it goes up when you hire and down when you automate.',
    'So we bill per confirmed booking. Nothing booked, nothing billed.',
    'That means we lose money when the product is bad. Which is the point.',
  ],
};
const INFO = {
  title: 'Outcome pricing',
  subtitle: 'What changed and why',
  stats: [
    { label: 'Billed per confirmed booking', value: '1', note: 'not per seat' },
    { label: 'Charged when nothing books', value: '$0' },
    { label: 'Contracts required', value: 'None' },
  ],
  steps: [
    { label: 'Connect the calendar', body: 'Read-only, one click, no migration.' },
    { label: 'Watch bookings land', body: 'Every one carries the receipt that attributes it.' },
  ],
  source: 'XXIautomate, 2026',
};

/* ────────────────────────────────────────────────────────────────────────────
 * 1. THE PIECES
 * ──────────────────────────────────────────────────────────────────────────── */

test('slugify produces something safe to use as a directory name', () => {
  assert.equal(slugify('Why we price per outcome'), 'why-we-price-per-outcome');
  assert.equal(slugify('Café pricing: what changed?'), 'cafe-pricing-what-changed');
  // ⚠️ THE SECURITY-SHAPED CASE: nothing that could traverse may survive.
  const nasty = slugify('../../etc/passwd');
  assert.ok(!nasty.includes('/') && !nasty.includes('\\') && !nasty.includes('..'), `a traversal survived: ${nasty}`);
  assert.equal(slugify(''), 'untitled');
  assert.equal(slugify('   '), 'untitled');
  assert.ok(slugify('a'.repeat(200)).length <= 60);
  assert.ok(!slugify('trailing punctuation!!!').endsWith('-'));
});

test('⭐ character counts are CODE POINTS, which is what a platform counts', () => {
  assert.equal(charCount('hello'), 5);
  // '👍'.length is 2 in JavaScript and 1 everywhere a post is measured.
  assert.equal(charCount('👍'), 1);
  assert.equal('👍'.length, 2, 'the premise of this test changed');
  assert.equal(charCount('a👍b'), 3);
  assert.equal(charCount(null), 0);
});

test('yamlScalar survives the characters that break front matter', () => {
  assert.equal(yamlScalar('Why we price: the argument'), '"Why we price: the argument"');
  assert.equal(yamlScalar('he said "hi"'), '"he said \\"hi\\""');
  assert.equal(yamlScalar('line\nbreak'), '"line break"');
  assert.equal(yamlScalar(7), '7');
  assert.equal(yamlScalar(true), 'true');
});

/* ── the thread ─────────────────────────────────────────────────────────── */

test('⭐⭐ the length check counts the COUNTER, because the platform does', () => {
  // 277 characters of body. Fits 280 alone; does NOT fit once " 1/2" (4 more) is appended.
  const long = 'x'.repeat(277);
  assert.equal(charCount(`${long} 1/2`), 281, 'the arithmetic this test rests on changed');
  const alone = buildThread([long], { platform: 'x' });
  assert.equal(alone.ok, true, 'a lone post with no counter should fit');

  const numbered = buildThread([long, 'second post'], { platform: 'x' });
  assert.equal(numbered.ok, false, 'the counter was not counted — this is the bug that ships');
  assert.match(numbered.error, /post 1 of 2/);
  assert.match(numbered.error, /280/);
  assert.match(numbered.error, /counter is included/);
});

test('the refusal says WHICH post and BY HOW MUCH, so the fix is one sentence', () => {
  const r = buildThread(['ok', 'y'.repeat(400), 'ok'], { platform: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.error, /post 2 of 3 is \d+ characters and x allows 280/);
  assert.match(r.error, /\d+ too many/);
  assert.match(r.error, /split_long_posts/);
});

test('every platform limit is honoured, and an unknown platform falls back rather than refusing', () => {
  const post = 'z'.repeat(320);
  assert.equal(buildThread([post], { platform: 'x' }).ok, false);
  assert.equal(buildThread([post], { platform: 'linkedin' }).ok, true);
  assert.equal(buildThread([post], { platform: 'bluesky' }).ok, false, `bluesky is ${PLATFORM_LIMITS.bluesky}`);
  const unknown = buildThread([post], { platform: 'some-new-network' });
  assert.equal(unknown.ok, true, 'an unlisted platform blocked the whole call');
  assert.equal(unknown.platform, 'generic');
  assert.equal(unknown.limit, PLATFORM_LIMITS.generic);
});

test('numbering is n/total and can be switched off', () => {
  const on = buildThread(['a', 'b', 'c'], { platform: 'x' });
  assert.deepEqual(on.posts.map((p) => p.text), ['a 1/3', 'b 2/3', 'c 3/3']);
  const off = buildThread(['a', 'b'], { platform: 'x', number: false });
  assert.deepEqual(off.posts.map((p) => p.text), ['a', 'b']);
  // A single post gets no counter — " 1/1" is noise.
  assert.deepEqual(buildThread(['only'], { platform: 'x' }).posts.map((p) => p.text), ['only']);
});

test('⭐ splitting is OPT-IN, splits on a sentence boundary, and never mid-word', () => {
  const text = `${'A sentence that is reasonably long. '.repeat(12)}End.`;
  const refused = buildThread([text], { platform: 'x' });
  assert.equal(refused.ok, false, 'copy was rewritten without being asked');

  const split = buildThread([text], { platform: 'x', split: true });
  assert.equal(split.ok, true, split.error);
  assert.ok(split.posts.length > 1);
  for (const p of split.posts) assert.ok(p.chars <= 280, `a split post is still ${p.chars} characters`);
  // ⚠️ Nothing was lost and nothing was cut through a word.
  const rejoined = split.posts.map((p) => p.text.replace(/ \d+\/\d+$/, '')).join(' ');
  assert.ok(rejoined.includes('End.'), 'the tail of the post disappeared in the split');
  for (const p of split.posts) assert.ok(!/\w-$/.test(p.text.replace(/ \d+\/\d+$/, '')), 'a word was cut in half');
});

test('splitPost makes progress even on one enormous unbroken word', () => {
  const parts = splitPost('q'.repeat(900), 100);
  assert.ok(parts.length > 1);
  assert.equal(parts.join('').length, 900, 'characters were lost in a hard cut');
});

test('a thread that is really a blog post is refused', () => {
  const many = Array.from({ length: MAX_THREAD_POSTS + 1 }, (_, i) => `post ${i}`);
  const r = buildThread(many, { platform: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.error, /that is a blog post, not a thread/);
  assert.equal(buildThread([], {}).ok, false);
  assert.equal(buildThread(['', '   '], {}).ok, false, 'blank posts counted as posts');
});

test('the rendered thread carries the counts a human needs to check it', () => {
  const t = buildThread(THREAD.posts, { platform: 'x' });
  const md = renderThread(t, { title: IDEA });
  assert.ok(md.includes('/280'), 'the limit is not shown beside each post');
  assert.ok(md.includes('1/3') && md.includes('3/3'));
  assert.ok(md.includes(THREAD.posts[2]));
});

/* ── the blog ───────────────────────────────────────────────────────────── */

test('⭐ the blog gets front matter, or nothing will render it', () => {
  const r = renderBlog(BLOG, { slug: 'why', date: '2026-08-25' });
  assert.equal(r.ok, true, r.error);
  assert.ok(r.markdown.startsWith('---\n'));
  assert.ok(r.markdown.includes('title: "Why we price per outcome: the whole argument"'), 'the colon in the title was not quoted');
  assert.ok(r.markdown.includes('slug: "why"'));
  assert.ok(r.markdown.includes('date: "2026-08-25"'));
  assert.ok(r.markdown.includes('tags: ["pricing", "saas"]'));
  assert.ok(r.markdown.includes('draft: true'), 'the post does not say it is a draft');
  assert.ok(r.markdown.includes('## The problem with seats'));
  /**
   * ⭐ THE NUMBER IN THE FRONT MATTER IS THE NUMBER IN THE RESULT. Two counts of
   * the same thing is how a manifest starts disagreeing with the file it
   * describes, and the disagreement is invisible until somebody checks by hand.
   */
  assert.ok(r.words > 25, `only ${r.words} words counted for a two-section post`);
  assert.ok(r.markdown.includes(`word_count: ${r.words}`), 'the front matter and the result disagree about the length');
  assert.equal(r.minutes, Math.max(1, Math.round(r.words / 225)));
  assert.ok(r.markdown.includes(`reading_time: ${r.minutes}`));
});

test('the blog accepts raw markdown instead of sections', () => {
  const r = renderBlog({ title: 'T', markdown: '# already written\n\nbody text here' }, { slug: 's', date: 'd' });
  assert.equal(r.ok, true, r.error);
  assert.ok(r.markdown.includes('already written'));
});

test('an empty blog refuses with the thing that is missing', () => {
  assert.match(renderBlog({}, { slug: 's', date: 'd' }).error, /needs a title/);
  assert.match(renderBlog({ title: 'T' }, { slug: 's', date: 'd' }).error, /markdown.*or at least one section/);
  assert.match(renderBlog({ title: 'T', sections: [{ heading: 'H' }] }, { slug: 's', date: 'd' }).error, /section 1 \("H"\) has no body/);
});

/* ── the infographic ────────────────────────────────────────────────────── */

test('the infographic is vector, self-contained, and escapes its labels', () => {
  const r = renderInfographic({ ...INFO, stats: [{ label: '</text><script>x()</script>', value: '1' }] }, { title: IDEA });
  assert.equal(r.ok, true, r.error);
  assert.ok(r.svg.startsWith('<svg '));
  assert.ok(!r.svg.includes('<script>'), 'markup from a label reached the SVG');
  assert.ok(!/https?:\/\//.test(r.svg.replace('http://www.w3.org/2000/svg', '')), 'the SVG references a remote URL');
  assert.ok(r.height > 0 && r.width === 1080);
});

test('the infographic refuses when there is nothing to draw', () => {
  assert.match(renderInfographic({}, { title: '' }).error, /needs a title/);
  assert.match(renderInfographic({ title: 'T' }, { title: 'T' }).error, /at least one stat or one step/);
  // A stat with no value is not a stat, and half-drawing it would be worse.
  assert.match(renderInfographic({ title: 'T', stats: [{ label: 'x' }] }, { title: 'T' }).error, /at least one stat/);
});

test('wrapLabel wraps on words and never exceeds its line budget', () => {
  const lines = wrapLabel('a fairly long label that will not fit on one line at all', 20, 2);
  assert.ok(lines.length <= 2);
  for (const l of lines) assert.ok([...l].length <= 20, `"${l}" is ${l.length} characters`);
  assert.deepEqual(wrapLabel('', 20, 2), []);
  assert.deepEqual(wrapLabel('short', 20, 2), ['short']);
});

/* ────────────────────────────────────────────────────────────────────────────
 * 2. THE VERB, END TO END
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐⭐ all three pieces land in one folder with a manifest', async (t) => {
  const root = workspace(t);
  const r = await syndicate(createLocalExecutor(root), {
    idea: IDEA, blog: BLOG, thread: THREAD, infographic: INFO,
  }, { now: FIXED });

  assert.equal(r.ok, true, r.error);
  assert.equal(r.slug, 'why-we-price-per-outcome');
  assert.equal(r.date, '2026-08-25', 'the date came from the clock rather than the injected one');
  assert.equal(r.dir, 'content/why-we-price-per-outcome');

  const files = readdirSync(join(root, 'content', 'why-we-price-per-outcome')).sort();
  assert.deepEqual(files, ['README.md', 'infographic.html', 'infographic.svg', 'post.md', 'thread.md']);

  // Each piece is REPORTED with the number a human would want to check.
  assert.equal(r.thread.posts, 3);
  assert.equal(r.thread.limit, 280);
  assert.ok(r.thread.longest <= 280);
  assert.ok(r.blog.words > 20);
  assert.equal(r.infographic.stats, 3);
  assert.equal(r.infographic.steps, 2);
  assert.match(r.next, /DRAFT/);

  const manifest = readFileSync(join(root, 'content/why-we-price-per-outcome/README.md'), 'utf8');
  assert.ok(manifest.includes(IDEA));
  assert.ok(manifest.includes('post.md') && manifest.includes('thread.md') && manifest.includes('infographic.html'));
  assert.ok(/DRAFT/.test(manifest), 'the manifest does not say these are drafts');
});

test('any single piece on its own is enough', async (t) => {
  const root = workspace(t);
  const ex = createLocalExecutor(root);
  const onlyThread = await syndicate(ex, { idea: 'a', thread: THREAD }, { now: FIXED });
  assert.equal(onlyThread.ok, true, onlyThread.error);
  assert.deepEqual(readdirSync(join(root, 'content', 'a')).sort(), ['README.md', 'thread.md']);
  assert.equal(onlyThread.blog, undefined, 'a blog was reported that was never written');
});

test('⚠️⚠️ the verb ASSEMBLES; it refuses to be asked to write the content', async (t) => {
  const root = workspace(t);
  const r = await syndicate(createLocalExecutor(root), { idea: 'just the idea, please write it' });
  assert.equal(r.ok, false);
  // ⭐ The refusal teaches the contract rather than naming a missing argument.
  assert.match(r.error, /ASSEMBLES/);
  assert.match(r.error, /Compose the blog, the thread and the infographic/);
  assert.equal(readdirSync(root).length, 0, 'a refused call created a folder');
});

test('an idea is required, because it is the slug and every default title', async (t) => {
  const root = workspace(t);
  const r = await syndicate(createLocalExecutor(root), { blog: BLOG });
  assert.equal(r.ok, false);
  assert.match(r.error, /`idea`/);
});

test('⚠️⚠️ a clash writes NOTHING — a half-syndicated folder looks finished', async (t) => {
  const root = workspace(t);
  const ex = createLocalExecutor(root);
  const first = await syndicate(ex, { idea: IDEA, blog: BLOG, thread: THREAD }, { now: FIXED });
  assert.equal(first.ok, true, first.error);
  const before = readFileSync(join(root, first.dir, 'post.md'), 'utf8');

  const second = await syndicate(ex, { idea: IDEA, blog: { ...BLOG, title: 'DIFFERENT' }, thread: THREAD }, { now: FIXED });
  assert.equal(second.ok, false);
  assert.match(second.error, /already exist/);
  assert.match(second.error, /Nothing was written/);
  assert.equal(readFileSync(join(root, first.dir, 'post.md'), 'utf8'), before, 'the refusal still overwrote a file');

  const third = await syndicate(ex, { idea: IDEA, blog: { ...BLOG, title: 'DIFFERENT' }, thread: THREAD, overwrite: true }, { now: FIXED });
  assert.equal(third.ok, true, third.error);
  assert.ok(readFileSync(join(root, first.dir, 'post.md'), 'utf8').includes('DIFFERENT'));
});

test('a bad piece refuses BEFORE anything is written, and names which piece', async (t) => {
  const root = workspace(t);
  const r = await syndicate(createLocalExecutor(root), {
    idea: IDEA, blog: BLOG, thread: { platform: 'x', posts: ['fine', 'q'.repeat(400)] },
  }, { now: FIXED });
  assert.equal(r.ok, false);
  assert.match(r.error, /^thread: /, 'the caller cannot tell which piece failed');
  assert.equal(existsSync(join(root, 'content')), false, 'the blog was written before the thread was validated');
});

test('the written infographic page is self-contained', async (t) => {
  const root = workspace(t);
  const r = await syndicate(createLocalExecutor(root), { idea: IDEA, infographic: INFO }, { now: FIXED });
  assert.equal(r.ok, true, r.error);
  const html = readFileSync(join(root, r.dir, 'infographic.html'), 'utf8');
  assert.ok(!/https?:\/\//i.test(html.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, '')), 'the page references a remote URL');
  assert.ok(!/<link\b|@import|\ssrc=/i.test(html), 'the page loads an external asset');
  assert.equal((html.match(/<script/g) || []).length, (html.match(/<\/script>/g) || []).length);

  // ⭐ The standalone .svg carries its OWN colour tokens, or it renders black on black.
  const svg = readFileSync(join(root, r.dir, 'infographic.svg'), 'utf8');
  assert.ok(svg.startsWith('<?xml'));
  assert.ok(svg.includes('<style>'), 'the portable SVG has no colours of its own');
  assert.ok(svg.includes('--ink:'), 'the portable SVG inherits tokens it will not have');
});

test('⭐ --dry-run previews and writes NOTHING', async (t) => {
  const root = workspace(t);
  const r = await syndicate(createLocalExecutor(root, { dryRun: true }), { idea: IDEA, blog: BLOG, thread: THREAD }, { now: FIXED });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.dryRun, true);
  assert.equal(existsSync(join(root, 'content')), false, 'a dry run put files on disk');
});

test('out_dir is honoured and a traversal is refused by the boundary that already exists', async (t) => {
  const root = workspace(t);
  const ex = createLocalExecutor(root);
  const ok = await syndicate(ex, { idea: 'x', out_dir: 'marketing/2026', thread: THREAD }, { now: FIXED });
  assert.equal(ok.ok, true, ok.error);
  assert.ok(existsSync(join(root, 'marketing', '2026', 'x', 'thread.md')));

  const out = await syndicate(ex, { idea: 'y', out_dir: '../escape', thread: THREAD }, { now: FIXED });
  assert.equal(out.ok, false, 'a path outside the workspace was written to');
});

/* ────────────────────────────────────────────────────────────────────────────
 * 3. REACHABILITY — a verb the model is never offered scores zero
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐⭐ syndicate is DECLARED, OFFERED and DISPATCHED, not merely written', async (t) => {
  const root = workspace(t);
  writeFileSync(join(root, 'index.js'), 'console.log(1);', 'utf8');

  assert.ok(TOOL_NAMES.includes('syndicate'), 'syndicate is not declared in TOOL_SCHEMAS');
  assert.ok(toolNamesForRounds(16, { root, env: {}, allowRun: true }).includes('syndicate'), 'syndicate is not offered on an ordinary project');
  assert.ok(toolNamesForRounds(16, { root, env: {}, allowRun: false }).includes('syndicate'), '--no-run withheld a verb that starts nothing');
  /**
   * ⚠️ WITHHELD FROM A SINGLE-SHOT TURN — see the note in chart.test.mjs. Two
   * guards outside this lane pin that list to an exact value; widening it is a
   * proposal, not something to smuggle past an assertion.
   */
  assert.ok(!toolNamesForRounds(1, { root, env: {}, allowRun: true }).includes('syndicate'));

  const out = await executeToolCall(
    { id: 's1', function: { name: 'syndicate', arguments: JSON.stringify({ idea: IDEA, thread: THREAD }) } },
    createLocalExecutor(root),
    { allowRun: true },
  );
  assert.equal(out.result.ok, true, out.result.error);
  assert.equal(out.mutated, true, 'files were written and the run summary would not count them');
  assert.ok(String(out.mutatedPath).includes('why-we-price-per-outcome'));
});

test('the schema names the tool once and the dispatcher answers to nothing else', async () => {
  const schemas = syndicateToolSchemas();
  assert.deepEqual(schemas.map((s) => s.function.name), [...SYNDICATE_TOOL_NAMES]);
  assert.deepEqual(syndicateToolNames(), ['syndicate']);
  // ⭐ The schema states the contract the refusal states, or the model learns it the expensive way.
  const description = schemas[0].function.description;
  assert.match(description, /WRITES NO CONTENT/);
  assert.match(description, /REFUSES/);
  const bogus = await runSyndicateTool('syndicated', {}, {});
  assert.equal(bogus.ok, false);
  assert.match(bogus.error, /unknown syndicate tool/);
});

test('⚠️ the MCP transport has decided about syndicate IN WRITING', () => {
  const reason = REFUSED_TOOL_REASONS.syndicate;
  assert.equal(typeof reason, 'string');
  assert.ok(reason.length > 40, `the refusal reason is a stub: ${reason}`);
});
