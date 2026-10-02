/**
 * ── ⭐ ONE SELF-CONTAINED HTML DOCUMENT SHELL, SHARED BY EVERY VERB THAT
 *    WRITES A PAGE ──────────────────────────────────────────────────────────
 *
 * `chart` and `syndicate` both emit an HTML file a human opens by
 * double-clicking it. That file has to satisfy four constraints, and all four
 * are the SAME four in both verbs — which is exactly the situation in which
 * this package has twice shipped two copies that then drifted apart
 * (`feedback_a_fix_that_cannot_be_imported`: *"a fix that cannot be imported
 * is a fix for one caller"*). So the shell lives here once and both import it.
 *
 *   1. ⚠️⚠️ **NO EXTERNAL ANYTHING.** No CDN script, no webfont, no stylesheet,
 *      no remote image. Two independent reasons, and either alone is decisive:
 *      · the published-app CSP allows only Google Fonts and blocks every other
 *        external CSS/JS (`project_acuvo_design_ceiling_is_selfhosting_not_
 *        skills`), so a page built with Chart.js renders blank in exactly the
 *        place a customer sees it; and
 *      · the file must open from `file://` on a laptop with no network, which
 *        is the ordinary case for "let me look at this CSV on the plane".
 *      There is therefore no charting library here and there is not meant to
 *      be. INTEGRATIONS.md clears no charting dependency, `acuvo-code` declares
 *      `"dependencies": {}` in its own package.json and says *"Zero
 *      dependencies, by design"* in its description, and the SVG we need is
 *      arithmetic rather than a library.
 *
 *   2. ⭐ **THE DATA GOES IN AS JSON, AND `</script>` IS THE BUG.** A CSV cell
 *      containing the eight characters `</script>` ends the script element
 *      early no matter how well-formed the JSON around it is — the HTML parser
 *      never sees the JavaScript string, it sees a close tag. `jsonForScript`
 *      below is the only sanctioned way to put data into a page from here.
 *
 *   3. ⭐ **BOTH THEMES, ALWAYS.** `prefers-color-scheme` plus a real toggle.
 *      A page that assumes light renders as a white slab in a dark terminal
 *      workflow, and a page that assumes dark prints as a black rectangle.
 *
 *   4. ⚠️ **ESCAPING IS NOT OPTIONAL AND IS NOT DONE BY EYE.** Column headers,
 *      cell values, blog headings and social posts are all attacker-adjacent
 *      text in the only sense that matters here: they came from a file or from
 *      a model, not from us. Everything that reaches markup goes through
 *      `escapeHtml` or `escapeAttr`.
 *
 * ⚠️ THIS FILE RENDERS. IT NEVER READS OR WRITES A FILE, never touches the
 * network, and never spends a credit. That is what lets both verbs' tests run
 * for free.
 */

/**
 * The five characters that change the meaning of markup. `&` first, or the
 * escapes escape each other.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Attribute values. Identical rules — the separate name exists so a reader can
 * see at the call site which context was intended, and so this can diverge
 * later without hunting for the call sites that meant "attribute".
 *
 * @param {unknown} value
 * @returns {string}
 */
export function escapeAttr(value) {
  return escapeHtml(value);
}

/**
 * ⭐⭐ JSON THAT IS SAFE INSIDE `<script>`.
 *
 * `JSON.stringify` is not enough and the reason is worth stating precisely: the
 * HTML tokenizer scans the raw text of a `<script>` element for `</script`
 * BEFORE any JavaScript exists, so a perfectly valid JSON string containing
 * that sequence terminates the element. `<!--` and `<!` have the same class of
 * problem in the legacy script-data-escaped states, and U+2028/U+2029 are line
 * terminators in JavaScript but not in JSON, which makes them a syntax error
 * inside a string literal.
 *
 * Every one of these is escaped as a `\uXXXX` sequence, which JSON.parse and a
 * JS string literal both decode back to the original character — so the DATA IS
 * UNCHANGED, only its spelling in the file is.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function jsonForScript(value) {
  /**
   * ⚠️ The two line separators are built with `String.fromCharCode` rather than
   * typed as literals. A raw U+2028 in a source file is invisible in every
   * editor, survives no copy-paste reliably, and this repo has already lost
   * characters that way (`feedback_escaping_through_layers_eats_characters`).
   * A test asserts the real characters really are escaped, so the construction
   * cannot rot into a no-op.
   */
  const LINE_SEP = String.fromCharCode(0x2028);
  const PARA_SEP = String.fromCharCode(0x2029);
  return JSON.stringify(value ?? null)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .split(LINE_SEP).join('\\u2028')
    .split(PARA_SEP).join('\\u2029');
}

/**
 * ── THE SHARED LOOK ─────────────────────────────────────────────────────────
 *
 * ⚠️ Deliberately small. It is a design system for two page shapes, not a
 * framework: tokens, a container, a card, a table, a tooltip, a toggle. Every
 * value is a CSS custom property so a caller can restyle without a fork.
 *
 * ⭐ The font stack is the SYSTEM stack. Not a preference — a webfont is a
 * network request, and constraint 1 above forbids one.
 */
export const BASE_CSS = `
:root{
  --bg:#fbfbfa; --panel:#ffffff; --ink:#16161a; --muted:#6b6b76; --line:#e6e6e3;
  --accent:#2f6df6; --shadow:0 1px 2px rgba(16,16,26,.06),0 8px 24px rgba(16,16,26,.05);
  --radius:14px;
  --s1:#2f6df6; --s2:#e0642f; --s3:#1f9d76; --s4:#8b5cf6; --s5:#d4a017; --s6:#c2427a;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#0e0e11; --panel:#17171c; --ink:#f2f2f0; --muted:#9a9aa6; --line:#2a2a33;
    --accent:#7aa2ff; --shadow:0 1px 2px rgba(0,0,0,.5),0 10px 30px rgba(0,0,0,.35);
    --s1:#7aa2ff; --s2:#ff9a62; --s3:#4fd1a5; --s4:#b394ff; --s5:#f2c94c; --s6:#ff7fb0;
  }
}
:root[data-theme="light"]{
  --bg:#fbfbfa; --panel:#ffffff; --ink:#16161a; --muted:#6b6b76; --line:#e6e6e3;
  --accent:#2f6df6;
  --s1:#2f6df6; --s2:#e0642f; --s3:#1f9d76; --s4:#8b5cf6; --s5:#d4a017; --s6:#c2427a;
}
:root[data-theme="dark"]{
  --bg:#0e0e11; --panel:#17171c; --ink:#f2f2f0; --muted:#9a9aa6; --line:#2a2a33;
  --accent:#7aa2ff;
  --s1:#7aa2ff; --s2:#ff9a62; --s3:#4fd1a5; --s4:#b394ff; --s5:#f2c94c; --s6:#ff7fb0;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  background:var(--bg); color:var(--ink);
  font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  -webkit-font-smoothing:antialiased;
}
.wrap{max-width:1180px;margin:0 auto;padding:34px 22px 72px}
header.top{display:flex;align-items:flex-start;gap:18px;flex-wrap:wrap;margin-bottom:26px}
header.top h1{font-size:26px;line-height:1.2;margin:0 0 4px;letter-spacing:-.02em;font-weight:650}
header.top .sub{color:var(--muted);font-size:13.5px;margin:0}
.spacer{flex:1 1 auto}
button.tgl{
  background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:999px;
  padding:7px 14px;font:inherit;font-size:13px;cursor:pointer;box-shadow:var(--shadow)
}
button.tgl:hover{border-color:var(--accent)}
.card{
  background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);
  box-shadow:var(--shadow);padding:18px 18px 14px;margin:0 0 20px;overflow:hidden
}
.card h2{font-size:15.5px;margin:0 0 2px;font-weight:620;letter-spacing:-.01em}
.card .note{color:var(--muted);font-size:12.5px;margin:0 0 12px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:12px;margin:0 0 20px}
.tile{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:13px 14px;box-shadow:var(--shadow)}
.tile .k{color:var(--muted);font-size:11.5px;text-transform:uppercase;letter-spacing:.07em;margin:0 0 5px}
.tile .v{font-size:21px;font-weight:640;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.legend{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0 2px}
.legend button{
  display:inline-flex;align-items:center;gap:6px;background:transparent;border:1px solid var(--line);
  border-radius:999px;padding:4px 10px;font:inherit;font-size:12px;color:var(--ink);cursor:pointer
}
.legend button[aria-pressed="false"]{opacity:.4}
.legend .sw{width:9px;height:9px;border-radius:2px;display:inline-block}
.plot{width:100%;overflow-x:auto}
svg{display:block;max-width:100%;height:auto}
svg text{font:11px ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;fill:var(--muted)}
svg .axis line,svg .axis path{stroke:var(--line)}
svg .grid line{stroke:var(--line);stroke-dasharray:2 3}
svg .mark{transition:opacity .12s}
svg .mark:hover{opacity:.78}
.tablewrap{overflow-x:auto;margin-top:6px}
table{border-collapse:collapse;width:100%;font-size:13px;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:7px 11px;border-bottom:1px solid var(--line);white-space:nowrap}
th{color:var(--muted);font-weight:560;font-size:11.5px;text-transform:uppercase;letter-spacing:.06em;cursor:pointer;user-select:none}
th:hover{color:var(--ink)}
td.num{text-align:right}
tbody tr:hover{background:color-mix(in srgb,var(--accent) 7%,transparent)}
#tip{
  position:fixed;pointer-events:none;opacity:0;transition:opacity .1s;z-index:9;
  background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:9px;
  padding:7px 10px;font-size:12.5px;box-shadow:var(--shadow);max-width:280px
}
footer.foot{color:var(--muted);font-size:12px;margin-top:30px;border-top:1px solid var(--line);padding-top:14px}
`.trim();

/**
 * The theme toggle. Shared because both pages have the button and neither
 * should own the behaviour.
 *
 * ⚠️ No `localStorage` read at the top level in a try-less form: a `file://`
 * page in some browsers throws on storage access, and an exception here would
 * abort the rest of the inline script — including the chart rendering.
 */
export const THEME_JS = `
(function(){
  var root=document.documentElement, btn=document.getElementById('theme');
  var saved=null; try{saved=localStorage.getItem('acuvo-theme');}catch(e){}
  if(saved) root.setAttribute('data-theme',saved);
  function current(){
    return root.getAttribute('data-theme') ||
      (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark':'light');
  }
  if(btn) btn.addEventListener('click',function(){
    var next = current()==='dark' ? 'light':'dark';
    root.setAttribute('data-theme',next);
    try{localStorage.setItem('acuvo-theme',next);}catch(e){}
  });
})();
`.trim();

/**
 * Assemble the document.
 *
 * ⭐ `lang` is set and `<meta name="viewport">` is present because the output is
 * a real page somebody opens on a phone, not a debug dump.
 *
 * @param {{ title: string, body: string, css?: string, js?: string, description?: string }} parts
 * @returns {string}
 */
export function htmlDocument({ title, body, css = '', js = '', description = '' }) {
  const style = `${BASE_CSS}\n${css}`.trim();
  const script = `${THEME_JS}\n${js}`.trim();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="generator" content="acuvo-code">
${description ? `<meta name="description" content="${escapeAttr(description)}">\n` : ''}<title>${escapeHtml(title)}</title>
<style>
${style}
</style>
</head>
<body>
${body}
<div id="tip" role="status"></div>
<script>
${script}
</script>
</body>
</html>
`;
}

/**
 * The series palette, by index, as CSS variable references. Six is deliberate:
 * past six categorical colours nobody can tell them apart, and a chart with
 * seven series is a chart that should have been a small-multiple.
 */
export const SERIES_VARS = Object.freeze(['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)']);

/** @param {number} i */
export const seriesColour = (i) => SERIES_VARS[((i % SERIES_VARS.length) + SERIES_VARS.length) % SERIES_VARS.length];
