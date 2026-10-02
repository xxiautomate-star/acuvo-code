/**
 * ── ⭐⭐ syndicate — ONE IDEA, EVERY FORMAT IT HAS TO EXIST IN ───────────────
 *
 * Roman's backlog: *"one idea → blog + infographic + social thread. The
 * content-multiplication verb."*
 *
 * ── ⚠️⚠️ THE MOST IMPORTANT DECISION IN THIS FILE: IT GENERATES NOTHING ─────
 *
 * The obvious build is a verb that takes `idea: "our new pricing"` and calls a
 * model three times. That version is wrong for four separate reasons, and any
 * one of them is enough:
 *
 *   1. ⭐ **THE MODEL IS ALREADY IN THE LOOP AND IS BETTER AT THIS THAN A NESTED
 *      CALL.** The agent calling this verb has the whole conversation — the
 *      user's voice, the product, what was decided three rounds ago. A nested
 *      generation starts from a one-line prompt and throws all of that away, so
 *      it produces worse copy at extra cost. `delegate` exists for the cases
 *      where a fresh context genuinely helps; this is not one.
 *   2. 💸 **A GENERATING VERB CANNOT BE TESTED FOR FREE.** Every assertion would
 *      need a mock, the mock would diverge from the real generator, and the
 *      suite would prove the mock works. `chart` and this verb are the only two
 *      creative-adjacent verbs in the package whose tests exercise the REAL code
 *      path end to end, and that is a direct consequence of this decision.
 *   3. ⚠️ **THE VALUE IS IN THE ASSEMBLY, AND THE ASSEMBLY IS WHERE IT BREAKS.**
 *      A thread whose numbering pushes post 4 to 283 characters. A slug with a
 *      slash in it. A blog post with no front matter, so nothing renders it.
 *      Files scattered so nobody can find what belongs to what. None of those
 *      are writing problems and none of them get better with a bigger model.
 *   4. ⭐ **IT KEEPS THE VERB GENERIC.** A verb that writes copy has to know what
 *      the copy is for. A verb that assembles pieces does not, and Roman's rule
 *      for this wave is *"none may hardcode for games"* — or for SaaS, or for
 *      agencies, or for anything.
 *
 * ⭐ SO THE CONTRACT IS: **the model composes, this verb assembles.** It owns
 * the file layout, the front matter, the slug, the numbering, the length
 * arithmetic, the infographic geometry and the manifest. It never writes a
 * sentence of anybody's content.
 *
 * ── ⚠️⚠️ THE LENGTH CHECK IS THE ONE THAT ACTUALLY SAVES PEOPLE ─────────────
 *
 * A social post limit is counted on the FINAL string, and the final string is
 * not the one the model wrote — it is the one with ` 4/9` on the end. So a
 * thread that "fits" at 280 is truncated at publish time, one post in nine, and
 * nobody notices until it is live. This verb numbers first and measures second,
 * and reports the overflow in characters with the post index, so the fix is one
 * specific sentence rather than a re-write.
 *
 * ⭐ AND IT COUNTS CODE POINTS, NOT UTF-16 UNITS. `'👍'.length` is 2 and every
 * platform counts it as one. `[...post].length` is the count that matches what
 * the platform does, and getting this wrong makes the verb wrong in exactly the
 * posts that use emoji — which is most of them.
 *
 * ── ⚠️ THE INFOGRAPHIC IS DRAWN, NOT RENDERED BY A SERVICE ──────────────────
 *
 * It is SVG inside a self-contained HTML file, built by the same shell `chart`
 * uses. No image model, no GPU, no credit, no 54-second wait, and it stays
 * legible at any size because it is vector. It is a STATS-AND-STEPS board — the
 * shape that actually gets shared — not an attempt at art. Anyone who wants art
 * has `generate_image`, and this verb deliberately does not compete with it.
 *
 * ── ⚠️ IT SPENDS NOTHING, STARTS NOTHING, AND REACHES NOTHING ───────────────
 *
 * No model call, no GPU, no network, no subprocess. Every file goes out through
 * the workspace executor, so `--dry-run`, the checkpoint journal, the write
 * lease and the credential-path leash are the ones that already exist.
 */

import { escapeHtml, htmlDocument, jsonForScript, seriesColour } from './html-doc.mjs';

export const SYNDICATE_TOOL_NAMES = Object.freeze(['syndicate']);

/**
 * ⚠️ THESE ARE PLATFORM FACTS, NOT A VERTICAL. A verb that knew about "SaaS
 * launch posts" would be hardcoded; one that knows a platform's character limit
 * is doing arithmetic. `generic` exists so the verb never blocks a platform we
 * have not listed — an unknown name falls back to it rather than refusing.
 */
export const PLATFORM_LIMITS = Object.freeze({
  x: 280,
  twitter: 280,
  bluesky: 300,
  mastodon: 500,
  threads: 500,
  linkedin: 3_000,
  reddit: 40_000,
  generic: 5_000,
});

/** Words per minute used for the reading-time estimate. The usual figure. */
export const READING_WPM = 225;

/** Bounds. Every one is a refusal with a sentence, never a silent truncation. */
export const MAX_THREAD_POSTS = 50;
export const MAX_BLOG_SECTIONS = 40;
export const MAX_STATS = 12;
export const MAX_STEPS = 8;

/* ────────────────────────────────────────────────────────────────────────────
 * 1. SMALL, PURE HELPERS
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * A filename-safe, URL-safe slug.
 *
 * ⚠️ THE POINT IS THE PATH, NOT THE PRETTINESS. This result becomes a directory
 * name, so anything that could traverse (`.`, `/`, `\`) or that Windows refuses
 * (`:`, `?`, `*`, `"`, `<`, `>`, `|`) must be gone before it reaches the
 * executor — which will refuse it anyway, but a refusal the caller cannot act on
 * is worse than a name that just works.
 *
 * ⚠️ KNOWN AND DELIBERATE LIMITATION: a title written entirely in a non-Latin
 * script slugs to `untitled`, because ASCII is the only alphabet every filesystem,
 * shell and URL agrees on. That is why `slug` is an argument — the caller
 * transliterates, which is a judgement call this function must not make.
 *
 * @param {string} text @param {number} [max]
 */
export function slugify(text, max = 60) {
  const base = String(text ?? '')
    .normalize('NFKD')
    // ⚠️ The combining-diacritic range, written as \u escapes. Typed as literal
    // characters these are INVISIBLE in every editor and do not survive a
    // copy-paste — the failure recorded in
    // `feedback_escaping_through_layers_eats_characters`. NFKD above splits "é"
    // into "e" + U+0301, and this drops the mark, so "café" slugs to "cafe"
    // rather than to "caf-".
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return base || 'untitled';
}

/** Code points, which is what a platform counts. `'👍'.length` is 2 and wrong. */
export const charCount = (s) => [...String(s ?? '')].length;

/** Words, for the reading estimate. */
export const wordCount = (s) => (String(s ?? '').trim().match(/\S+/g) ?? []).length;

/**
 * ⚠️ YAML FRONT MATTER IS NOT `key: value`. A title containing a colon, a `#`,
 * or leading whitespace breaks every static-site generator that reads it, and
 * the breakage looks like "the post has no title" rather than like a parse
 * error. Quoting and escaping the quote is the whole fix.
 *
 * @param {unknown} v
 */
export function yamlScalar(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return String(v);
  const s = String(v ?? '');
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`;
}

/**
 * Split one over-long post on a sentence boundary, then a word boundary, never
 * mid-word.
 *
 * ⭐ IT IS OPT-IN (`split_long_posts`). Splitting somebody's copy without being
 * asked is editing it, and a verb that silently rewrites content is one nobody
 * can trust with the next piece. The DEFAULT is to refuse and say which post and
 * by how much.
 *
 * @param {string} text @param {number} limit @param {number} suffixCost
 * @returns {string[]}
 */
export function splitPost(text, limit, suffixCost = 0) {
  const room = Math.max(20, limit - suffixCost);
  const chars = [...String(text ?? '')];
  if (chars.length <= room) return [String(text ?? '')];

  const out = [];
  let rest = String(text ?? '').trim();
  // A hard bound: a limit small enough to make no progress must not spin.
  for (let guard = 0; rest && guard < MAX_THREAD_POSTS * 2; guard++) {
    const head = [...rest];
    if (head.length <= room) { out.push(rest); break; }
    const window = head.slice(0, room).join('');
    let cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '));
    if (cut > room * 0.4) cut += 1;
    else {
      cut = window.lastIndexOf(' ');
      if (cut <= 0) cut = window.length; // one enormous word: hard cut, nothing else is possible
    }
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  return out.filter(Boolean);
}

/* ────────────────────────────────────────────────────────────────────────────
 * 2. THE THREAD
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Number the posts and measure them AFTER numbering.
 *
 * @param {string[]} posts
 * @param {{ platform?: string, number?: boolean, split?: boolean }} [opts]
 * @returns {{ ok: true, platform: string, limit: number, posts: Array<{ n: number, text: string, chars: number }> }
 *          | { ok: false, error: string }}
 */
export function buildThread(posts, { platform = 'x', number = true, split = false } = {}) {
  const key = String(platform ?? 'x').toLowerCase();
  const limit = PLATFORM_LIMITS[key] ?? PLATFORM_LIMITS.generic;
  const named = Object.prototype.hasOwnProperty.call(PLATFORM_LIMITS, key) ? key : 'generic';

  let list = (posts ?? []).map((p) => String(p ?? '').trim()).filter(Boolean);
  if (list.length === 0) return { ok: false, error: 'the thread has no posts' };

  if (split) {
    /**
     * ⚠️ THE SUFFIX COST IS ESTIMATED FROM THE POST-SPLIT COUNT, WHICH IS NOT
     * KNOWN UNTIL AFTER THE SPLIT. Splitting can only ever grow the count, so
     * estimating from a generous upper bound and re-measuring below is the order
     * that cannot under-count. Getting this backwards is exactly the bug this
     * function exists to prevent.
     */
    const estimate = number ? charCount(` ${list.length * 2}/${list.length * 2}`) : 0;
    list = list.flatMap((p) => splitPost(p, limit, estimate));
  }
  if (list.length > MAX_THREAD_POSTS) {
    return { ok: false, error: `a ${list.length}-post thread is past the ${MAX_THREAD_POSTS}-post ceiling — that is a blog post, not a thread` };
  }

  const total = list.length;
  const built = list.map((text, i) => {
    const suffix = number && total > 1 ? ` ${i + 1}/${total}` : '';
    const full = `${text}${suffix}`;
    return { n: i + 1, text: full, chars: charCount(full) };
  });

  const over = built.filter((p) => p.chars > limit);
  if (over.length) {
    const worst = over[0];
    return {
      ok: false,
      error: `post ${worst.n} of ${total} is ${worst.chars} characters and ${named} allows ${limit}`
        + ` — ${worst.chars - limit} too many${number && total > 1 ? ` (the " ${worst.n}/${total}" counter is included, because the platform counts it)` : ''}.`
        + `${over.length > 1 ? ` ${over.length} posts are over.` : ''}`
        + ' Shorten it, or pass split_long_posts: true to break it on a sentence boundary.',
    };
  }
  return { ok: true, platform: named, limit, posts: built };
}

/** The thread as a markdown file a human can copy from, post by post. */
export function renderThread(thread, { title = '' } = {}) {
  const head = title ? `# ${title} — thread\n\n` : '# Thread\n\n';
  const meta = `<!-- ${thread.platform} · limit ${thread.limit} characters · ${thread.posts.length} posts -->\n\n`;
  return head + meta + thread.posts.map((p) => `## ${p.n}/${thread.posts.length}  ·  ${p.chars}/${thread.limit}\n\n${p.text}\n`).join('\n---\n\n');
}

/* ────────────────────────────────────────────────────────────────────────────
 * 3. THE BLOG POST
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * @param {Record<string, any>} blog
 * @param {{ slug: string, date: string }} ctx
 * @returns {{ ok: true, markdown: string, words: number, minutes: number, title: string }
 *          | { ok: false, error: string }}
 */
export function renderBlog(blog, { slug, date }) {
  const title = String(blog.title ?? '').trim();
  if (!title) return { ok: false, error: 'the blog needs a title' };

  let bodyMd = '';
  if (typeof blog.markdown === 'string' && blog.markdown.trim()) {
    bodyMd = blog.markdown.trim();
  } else {
    const sections = Array.isArray(blog.sections) ? blog.sections : [];
    if (sections.length === 0) return { ok: false, error: 'the blog needs either `markdown` or at least one section' };
    if (sections.length > MAX_BLOG_SECTIONS) return { ok: false, error: `${sections.length} sections is past the ${MAX_BLOG_SECTIONS}-section ceiling` };
    const parts = [];
    for (const [i, s] of sections.entries()) {
      const heading = String(s?.heading ?? '').trim();
      const body = String(s?.body ?? '').trim();
      if (!body) return { ok: false, error: `section ${i + 1}${heading ? ` ("${heading}")` : ''} has no body` };
      if (heading) parts.push(`## ${heading}`);
      parts.push(body);
    }
    bodyMd = parts.join('\n\n');
  }

  const dek = String(blog.dek ?? blog.subtitle ?? '').trim();
  const tags = (Array.isArray(blog.tags) ? blog.tags : []).map((tg) => String(tg ?? '').trim()).filter(Boolean);
  const words = wordCount(bodyMd);
  const minutes = Math.max(1, Math.round(words / READING_WPM));

  /**
   * ⭐ FRONT MATTER IS WHAT MAKES THIS A POST RATHER THAN A TEXT FILE. Every
   * static-site generator worth using reads it, and writing the file without it
   * means somebody hand-edits every one.
   */
  const front = [
    '---',
    `title: ${yamlScalar(title)}`,
    dek ? `description: ${yamlScalar(dek)}` : null,
    `slug: ${yamlScalar(slug)}`,
    `date: ${yamlScalar(date)}`,
    tags.length ? `tags: [${tags.map(yamlScalar).join(', ')}]` : null,
    `reading_time: ${minutes}`,
    `word_count: ${words}`,
    'draft: true',
    '---',
  ].filter(Boolean).join('\n');

  const markdown = `${front}\n\n# ${title}\n\n${dek ? `*${dek}*\n\n` : ''}${bodyMd}\n`;
  return { ok: true, markdown, words, minutes, title };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 4. THE INFOGRAPHIC
 * ──────────────────────────────────────────────────────────────────────────── */

const CARD_W = 1080;

/**
 * A stats-and-steps board as inline SVG in a self-contained page.
 *
 * ⚠️ TEXT IS WRAPPED HERE, IN JAVASCRIPT, because SVG has no text wrapping. A
 * label longer than its box does not ellipsize, it runs off the canvas and out
 * of the exported image — silently. `wrapLabel` is why this is not a two-line
 * function.
 *
 * @param {Record<string, any>} info
 * @param {{ title: string }} ctx
 */
export function renderInfographic(info, { title }) {
  const heading = String(info.title ?? title ?? '').trim();
  const sub = String(info.subtitle ?? '').trim();
  const stats = (Array.isArray(info.stats) ? info.stats : []).slice(0, MAX_STATS)
    .map((s) => ({ label: String(s?.label ?? '').trim(), value: String(s?.value ?? '').trim(), note: String(s?.note ?? '').trim() }))
    .filter((s) => s.label && s.value);
  const steps = (Array.isArray(info.steps) ? info.steps : []).slice(0, MAX_STEPS)
    .map((s) => ({ label: String(s?.label ?? '').trim(), body: String(s?.body ?? '').trim() }))
    .filter((s) => s.label);

  const source = String(info.source ?? '').trim();

  if (!heading) return { ok: false, error: 'the infographic needs a title' };
  if (stats.length === 0 && steps.length === 0) return { ok: false, error: 'the infographic needs at least one stat or one step' };

  const cols = stats.length <= 2 ? stats.length || 1 : stats.length <= 4 ? 2 : 3;
  const rows = Math.ceil(stats.length / cols);
  const cellW = (CARD_W - 80 - (cols - 1) * 24) / cols;
  const cellH = 150;
  const headH = sub ? 168 : 128;
  const statsH = stats.length ? rows * (cellH + 24) : 0;
  const stepH = 92;
  /**
   * ⚠️ TIGHTENED AFTER RENDERING IT. The first version added 44 + 64 of trailing
   * space below the last step, which put roughly 100px of nothing between the
   * final line and the source credit — the card read as unfinished rather than
   * as spacious. The step block already carries 40px of its own bottom padding
   * inside `stepH`, so the only extra needed is room for the credit line.
   */
  const stepsH = steps.length ? steps.length * stepH : 0;
  const H = headH + statsH + stepsH + (source ? 52 : 28);

  const parts = [];
  parts.push(`<rect x="0" y="0" width="${CARD_W}" height="${H}" rx="0" style="fill:var(--panel)"/>`);
  parts.push(`<text x="40" y="72" style="fill:var(--ink);font-size:40px;font-weight:650;letter-spacing:-.02em">${escapeHtml(clip(heading, 46))}</text>`);
  if (sub) parts.push(`<text x="40" y="112" style="fill:var(--muted);font-size:19px">${escapeHtml(clip(sub, 84))}</text>`);
  parts.push(`<line x1="40" y1="${headH - 30}" x2="${CARD_W - 40}" y2="${headH - 30}" style="stroke:var(--line)"/>`);

  stats.forEach((s, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    const x = 40 + c * (cellW + 24);
    const y = headH + r * (cellH + 24);
    parts.push(`<rect x="${x}" y="${y}" width="${cellW.toFixed(1)}" height="${cellH}" rx="16" style="fill:var(--bg);stroke:var(--line)"/>`);
    parts.push(`<text x="${x + 24}" y="${y + 62}" style="fill:${seriesColour(i)};font-size:44px;font-weight:660;letter-spacing:-.03em">${escapeHtml(clip(s.value, 14))}</text>`);
    wrapLabel(s.label, Math.floor(cellW / 9.2), 2).forEach((line, li) => {
      parts.push(`<text x="${x + 24}" y="${y + 92 + li * 22}" style="fill:var(--ink);font-size:16px">${escapeHtml(line)}</text>`);
    });
    if (s.note) parts.push(`<text x="${x + 24}" y="${y + cellH - 18}" style="fill:var(--muted);font-size:13px">${escapeHtml(clip(s.note, Math.floor(cellW / 7)))}</text>`);
  });

  const stepTop = headH + statsH + (steps.length ? 22 : 0);
  steps.forEach((s, i) => {
    const y = stepTop + i * stepH;
    parts.push(`<circle cx="64" cy="${y + 30}" r="20" style="fill:${seriesColour(i)}"/>`);
    parts.push(`<text x="64" y="${y + 37}" text-anchor="middle" style="fill:var(--panel);font-size:17px;font-weight:660">${i + 1}</text>`);
    parts.push(`<text x="100" y="${y + 27}" style="fill:var(--ink);font-size:21px;font-weight:600">${escapeHtml(clip(s.label, 62))}</text>`);
    if (s.body) {
      wrapLabel(s.body, 96, 2).forEach((line, li) => {
        parts.push(`<text x="100" y="${y + 52 + li * 21}" style="fill:var(--muted);font-size:15.5px">${escapeHtml(line)}</text>`);
      });
    }
    if (i < steps.length - 1) parts.push(`<line x1="64" y1="${y + 52}" x2="64" y2="${y + stepH + 8}" style="stroke:var(--line)"/>`);
  });

  if (source) parts.push(`<text x="40" y="${H - 22}" style="fill:var(--muted);font-size:13px">${escapeHtml(clip(source, 120))}</text>`);

  const svg = `<svg viewBox="0 0 ${CARD_W} ${H}" width="${CARD_W}" height="${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeHtml(heading)}">${parts.join('')}</svg>`;
  return { ok: true, svg, width: CARD_W, height: H, stats: stats.length, steps: steps.length };
}

const clip = (s, n) => ([...s].length > n ? `${[...s].slice(0, n - 1).join('')}…` : s);

/**
 * Greedy word wrap to `perLine` characters and at most `maxLines` lines.
 * @param {string} text @param {number} perLine @param {number} maxLines
 */
export function wrapLabel(text, perLine, maxLines) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if ([...next].length > perLine && line) { lines.push(line); line = w; } else line = next;
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) {
    lines[maxLines - 1] = clip(lines[maxLines - 1], perLine);
  }
  return lines;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 5. THE VERB
 * ──────────────────────────────────────────────────────────────────────────── */

/** The date, as YYYY-MM-DD, injectable so a test is not a clock. */
const today = (now = new Date()) => now.toISOString().slice(0, 10);

/**
 * @param {{ readFile: Function, writeFile: Function }} executor
 * @param {Record<string, any>} args
 * @param {{ now?: Date }} [opts]
 */
export async function syndicate(executor, args = {}, { now = new Date() } = {}) {
  if (!executor || typeof executor.writeFile !== 'function' || typeof executor.readFile !== 'function') {
    return { ok: false, error: 'no workspace is available, so there is nowhere to write the pieces' };
  }
  const idea = String(args.idea ?? '').trim();
  if (!idea) return { ok: false, error: 'name the `idea` in one line — it becomes the slug, the manifest heading and the default title for every piece' };

  const hasBlog = args.blog && typeof args.blog === 'object';
  const hasThread = args.thread && typeof args.thread === 'object';
  const hasInfographic = args.infographic && typeof args.infographic === 'object';
  if (!hasBlog && !hasThread && !hasInfographic) {
    /**
     * ⚠️⚠️ THIS REFUSAL IS THE VERB'S WHOLE CONTRACT, SO IT SAYS THE CONTRACT
     * RATHER THAN "missing argument". The predictable first call is
     * `syndicate({idea})` expecting the pieces to be written FOR the caller, and
     * a terse refusal there teaches nothing. This one names who writes what.
     */
    return {
      ok: false,
      error: 'this verb ASSEMBLES pieces; it does not write them. Compose the blog, the thread and the infographic '
        + 'yourself — you have the whole conversation and a nested generation would not — then pass at least one of '
        + '`blog`, `thread` or `infographic`. It owns the file layout, the front matter, the slug, the post numbering, '
        + 'the character-limit arithmetic and the manifest.',
    };
  }

  const slug = args.slug ? slugify(args.slug) : slugify(idea);
  const dir = String(args.out_dir ?? 'content').trim().replace(/[\\/]+$/, '');
  const base = `${dir}/${slug}`;
  const date = today(now);
  const overwrite = args.overwrite === true;

  /** @type {Array<{ path: string, content: string, kind: string }>} */
  const planned = [];
  const summary = { slug, date };

  if (hasBlog) {
    const built = renderBlog(args.blog, { slug, date });
    if (!built.ok) return { ok: false, error: `blog: ${built.error}` };
    planned.push({ path: `${base}/post.md`, content: built.markdown, kind: 'blog' });
    summary.blog = { title: built.title, words: built.words, reading_minutes: built.minutes };
  }

  if (hasThread) {
    const built = buildThread(args.thread.posts, {
      platform: args.thread.platform,
      number: args.thread.number !== false,
      split: args.split_long_posts === true,
    });
    if (!built.ok) return { ok: false, error: `thread: ${built.error}` };
    planned.push({ path: `${base}/thread.md`, content: renderThread(built, { title: idea }), kind: 'thread' });
    summary.thread = {
      platform: built.platform, limit: built.limit, posts: built.posts.length,
      longest: Math.max(...built.posts.map((p) => p.chars)),
      characters: built.posts.map((p) => p.chars),
    };
  }

  if (hasInfographic) {
    const built = renderInfographic(args.infographic, { title: idea });
    if (!built.ok) return { ok: false, error: `infographic: ${built.error}` };
    const page = htmlDocument({
      title: `${idea} — infographic`,
      description: idea,
      body: `<div class="wrap"><header class="top"><div><h1>${escapeHtml(idea)}</h1>`
        + `<p class="sub">infographic · ${built.width}×${built.height} · select the card and copy, or print to PDF</p></div>`
        + '<div class="spacer"></div><button class="tgl" id="theme" type="button">Theme</button></header>'
        + `<section class="card" style="padding:0">${built.svg}</section>`
        + '<footer class="foot">Self-contained vector: nothing is loaded from the network, and it stays sharp at any size.</footer></div>',
      /**
       * ⭐ THE ONE PLACE IN THIS FILE WHERE DATA REACHES A `<script>`, and it
       * goes through `jsonForScript` for exactly the reason that function
       * exists: a stat label containing `</script>` would otherwise end the
       * element. It is inert data — a copy of the source the page was built
       * from, so a reader can see what it was drawn from.
       */
      js: `window.__syndicate=${jsonForScript({ idea, slug, date, stats: built.stats, steps: built.steps })};`,
    });
    planned.push({ path: `${base}/infographic.html`, content: page, kind: 'infographic' });
    planned.push({ path: `${base}/infographic.svg`, content: `<?xml version="1.0" encoding="UTF-8"?>\n${standaloneSvg(built.svg)}\n`, kind: 'infographic-svg' });
    summary.infographic = { width: built.width, height: built.height, stats: built.stats, steps: built.steps };
  }

  planned.push({ path: `${base}/README.md`, content: manifest({ idea, slug, date, summary, planned }), kind: 'manifest' });

  /**
   * ⚠️⚠️ EVERY DESTINATION IS CHECKED BEFORE THE FIRST BYTE IS WRITTEN. A verb
   * that writes four files and refuses on the fifth leaves a half-syndicated
   * directory that looks finished — the worst possible outcome, because the
   * missing piece is the one nobody notices. All-or-nothing is the only honest
   * shape for a multi-file write.
   */
  if (!overwrite) {
    const clash = planned.map((p) => executor.readFile(p.path)).filter((r) => r.ok);
    if (clash.length) {
      return {
        ok: false,
        error: `${clash.map((c) => c.path).join(', ')} already exist${clash.length === 1 ? 's' : ''}. `
          + 'Nothing was written. Pass overwrite: true, or choose a different slug.',
      };
    }
  }

  const written = [];
  for (const piece of planned) {
    const res = executor.writeFile(piece.path, piece.content);
    if (!res.ok) {
      return {
        ok: false,
        error: `${piece.path}: ${res.error}`,
        written: written.map((w) => w.path),
        partial: written.length > 0,
      };
    }
    written.push({ path: res.path, kind: piece.kind, bytes: res.bytes, dryRun: res.dryRun === true });
  }

  return {
    ok: true,
    slug,
    dir: base,
    date,
    dryRun: written.every((w) => w.dryRun),
    files: written.map(({ path, kind, bytes }) => ({ path, kind, bytes })),
    ...summary,
    next: 'every piece is a DRAFT — the blog carries `draft: true` in its front matter and nothing here was published anywhere',
  };
}

/**
 * ⚠️ THE STANDALONE `.svg` NEEDS ITS COLOURS RESOLVED. The HTML page inherits
 * `var(--ink)` and friends from the document; a bare `.svg` opened on its own has
 * no such document and every element renders black-on-black. So the standalone
 * copy carries its own `<style>` defining the same tokens, and the file is
 * genuinely portable rather than portable-looking.
 */
function standaloneSvg(svg) {
  const tokens = ':root,svg{--panel:#ffffff;--bg:#fbfbfa;--ink:#16161a;--muted:#6b6b76;--line:#e6e6e3;'
    + '--s1:#2f6df6;--s2:#e0642f;--s3:#1f9d76;--s4:#8b5cf6;--s5:#d4a017;--s6:#c2427a}'
    + 'text{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}';
  return svg.replace('>', `><style>${tokens}</style>`);
}

/** The manifest: what exists, how long it is, and where each piece goes. */
function manifest({ idea, slug, date, summary, planned }) {
  const lines = [`# ${idea}`, '', `- slug: \`${slug}\``, `- date: ${date}`, '', '## Pieces', ''];
  for (const p of planned) {
    if (p.kind === 'manifest') continue;
    lines.push(`- \`${p.path.split('/').pop()}\` — ${describe(p.kind, summary)}`);
  }
  lines.push('', '## Status', '', 'Every piece is a DRAFT. The blog front matter carries `draft: true`.',
    'Nothing here has been published, posted or sent anywhere — this verb writes files and does nothing else.', '');
  return lines.join('\n');
}

const describe = (kind, s) => ({
  blog: s.blog ? `blog post, ${s.blog.words} words, about ${s.blog.reading_minutes} min` : 'blog post',
  thread: s.thread ? `${s.thread.posts}-post ${s.thread.platform} thread, longest ${s.thread.longest}/${s.thread.limit} characters` : 'thread',
  infographic: s.infographic ? `infographic, ${s.infographic.width}×${s.infographic.height}, self-contained HTML` : 'infographic',
  'infographic-svg': 'the same infographic as a portable .svg',
}[kind] ?? kind);

/**
 * ⭐ NO ENVIRONMENT GATE AND NO PROJECT GATE — it writes files and nothing else,
 * so its presence never varies and its bytes stay in the cached prompt prefix.
 *
 * ⚠️ MULTI-ROUND ONLY, for the same reason `chart` is: two existing guards pin
 * the single-shot offer to an exact list and widening it is not this lane's
 * decision. See `chart.mjs`'s note for the file and line numbers.
 *
 * @param {{ maxRounds?: number }} [opts]
 */
export function syndicateToolNames({ maxRounds = 2 } = {}) {
  if (maxRounds <= 1) return [];
  return [...SYNDICATE_TOOL_NAMES];
}

export function syndicateToolSchemas() {
  return [
    {
      type: 'function',
      function: {
        name: 'syndicate',
        /**
         * ⚠️ EVERY WORD HERE IS PAID FOR ON EVERY ROUND OF EVERY TASK THAT
         * SELECTS THE `content` GROUP. The first draft of this schema was 3,194
         * bytes, which took the package's full offer to 57,465 against the
         * 60,000-byte ceiling `declared-tools-are-named.test.mjs` asserts —
         * leaving the next verb almost no room. It says what the caller cannot
         * guess and nothing else; the reasoning lives in this file's header,
         * which costs nothing.
         */
        description: [
          'Assemble ONE idea into a blog post with front matter, a numbered social thread checked against the platform',
          'character limit, and a vector infographic — one folder, plus a manifest.',
          '⚠️ IT WRITES NO CONTENT: you compose the pieces, it owns layout, slug, front matter, numbering and the',
          'character arithmetic. REFUSES an over-limit post, naming which and by how much (the counter counts).',
          'Nothing is published; every piece is a draft on disk. Costs nothing — no model, no GPU.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            idea: { type: 'string', description: 'One-line thesis. Becomes the slug and the manifest heading.' },
            out_dir: { type: 'string', description: 'Workspace-relative parent folder. Default "content".' },
            slug: { type: 'string', description: 'Override the slug derived from idea.' },
            blog: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                dek: { type: 'string', description: 'One-line standfirst.' },
                sections: {
                  type: 'array',
                  description: 'Ordered sections; preferred over markdown.',
                  items: { type: 'object', properties: { heading: { type: 'string' }, body: { type: 'string' } }, required: ['body'] },
                },
                markdown: { type: 'string', description: 'Whole body as markdown, instead of sections.' },
                tags: { type: 'array', items: { type: 'string' } },
              },
              required: ['title'],
            },
            thread: {
              type: 'object',
              properties: {
                platform: { type: 'string', enum: Object.keys(PLATFORM_LIMITS), description: 'Sets the limit. Default x (280).' },
                posts: { type: 'array', items: { type: 'string' }, description: 'One string per post, in order, WITHOUT numbering — added and counted for you.' },
                number: { type: 'boolean', description: 'Append " 1/7". Default true.' },
              },
              required: ['posts'],
            },
            infographic: {
              type: 'object',
              description: 'A stats-and-steps board drawn as SVG. No image model.',
              properties: {
                title: { type: 'string' },
                subtitle: { type: 'string' },
                stats: {
                  type: 'array',
                  items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'string' }, note: { type: 'string' } }, required: ['label', 'value'] },
                },
                steps: {
                  type: 'array',
                  description: 'An ordered process, numbered and joined.',
                  items: { type: 'object', properties: { label: { type: 'string' }, body: { type: 'string' } }, required: ['label'] },
                },
                source: { type: 'string', description: 'Attribution line.' },
              },
            },
            split_long_posts: { type: 'boolean', description: 'Break an over-long post on a sentence boundary instead of refusing. Default false.' },
            overwrite: { type: 'boolean', description: 'Replace files already there. Default false; a clash writes nothing.' },
          },
          required: ['idea'],
        },
      },
    },
  ];
}

/** Dispatch. Mirrors the shape every other tool module in this package uses. */
export async function runSyndicateTool(name, args = {}, { executor } = {}) {
  if (name !== 'syndicate') return { ok: false, error: `unknown syndicate tool "${name}"` };
  return syndicate(executor, args);
}
