/**
 * ── ⭐⭐⭐ THE DEPRECATION SIGNAL THAT SEARCH CANNOT GIVE YOU ─────────────────
 *
 * Roman named the pillar: *"DYNAMIC WEB CONTEXT — query live docs/APIs at build
 * time so we never emit deprecated code. So important."*
 *
 * `web_search` was built for that and it is the wrong shape for half the job.
 * A search engine ranks by POPULARITY, and the most popular page about a
 * library is almost always the OLD one — the 2019 StackOverflow answer with
 * 4,000 upvotes, not the release note from March. Searching "zod email
 * validation" is a reliable way to be told to write `z.string().email()`,
 * which is exactly the wrong-version idiom this package's own probes already
 * caught the model emitting (see the header of `fetch-text.mjs`: *"a
 * wrong-version idiom under an explicit 'use the v4 APIs' instruction,
 * asserted as 'The code itself is correct'"*).
 *
 * ── ⭐ WHAT WAS MEASURED, BEFORE ANY OF THIS WAS WRITTEN (2026-08-25) ────────
 *
 * Three keyless GETs against `registry.npmjs.org`, from a real machine:
 *
 *   GET /zod/latest       200 · 4,033 bytes · 510ms
 *                         version 4.4.3 · homepage https://zod.dev
 *   GET /request          200 · deprecated: "request has been deprecated, see
 *                         https://github.com/request/request/issues/3142"
 *   GET /left-pad         200 · deprecated: "use String.prototype.padStart()"
 *   GET /<nonexistent>    404
 *
 * ⭐ THREE THINGS FALL OUT OF ONE 4KB REQUEST that no amount of searching
 * reliably produces:
 *
 *   1. the EXACT current version — so "is this API current" becomes a fact
 *      instead of a vibe. `zod` is on **4.4.3**; a model trained before the v4
 *      release will write v3 code with total confidence.
 *   2. a MACHINE-READABLE `deprecated` string, written by the maintainer. This
 *      is the only structured "do not use this" signal on the public internet.
 *      Nothing in a search result carries it.
 *   3. the CANONICAL docs URL (`homepage`), which turns the next step from
 *      "search and hope you land on the right page" into one `fetch_url`.
 *
 * ── 🧩 ASSEMBLED, NOT AUTHORED ──────────────────────────────────────────────
 *
 * This is the assembler doctrine applied literally: npm already runs the
 * registry, already stores the deprecation notice, and already serves it free
 * and keyless with CORS wide open. We add a candidate extractor, a cap and a
 * renderer. There is no model, no key, no host, and no bill.
 *
 * ⚠️ AND IT IS DELIBERATELY *NOT* A SECOND SEARCH VERB. The measured failure in
 * this repo is never "the model lacked a verb" — it is that a verb was
 * registered and never reached (`[[feedback_an_option_is_not_a_default]]`, and
 * `tools.mjs`'s own note that *"a verb is three things: a schema, a dispatch,
 * AND a sentence telling the model when to reach for it"*). So this rides
 * INSIDE `web_search`, fires without being asked, and prepends its answer to
 * the results the model was already going to read. A capability that needs the
 * model to opt in is a capability that does not exist.
 *
 * ⚠️ NO WORKSPACE ACCESS, ON PURPOSE. The version a project actually PINS lives
 * in its package.json, and this module never sees it — `executeToolCall`
 * forwards only the model's own arguments to `webSearch`. So this reports what
 * npm says is CURRENT and says so in those words; it must never be phrased as
 * "the version you are using", which would be a confident lie on any repo with
 * a lockfile. Reconciling the two is a separate, larger piece of work and is
 * written up in the report rather than faked here.
 */

/** One 4KB document. A doc lookup is fast or it is not happening. */
export const PACKAGE_TIMEOUT_MS = 6_000;

/**
 * ⚠️ ITS OWN BUDGET, SEPARATE FROM THE SEARCH CAP. This runs as a silent
 * enrichment on searches the model already paid for, so charging it against
 * `MAX_SEARCHES_PER_PROCESS` would quietly halve the search budget for a
 * benefit the model never asked for. It still needs a ceiling — an enrichment
 * with no cap is a crawl nobody watches.
 */
export const MAX_LOOKUPS_PER_PROCESS = 12;

/** Longest name npm will accept. Anything longer is not a package. */
const MAX_NAME_CHARS = 214;

export const REGISTRY = 'https://registry.npmjs.org';

let lookupsThisProcess = 0;
/** name → resolved record, so two searches naming the same package cost one GET. */
const cache = new Map();

/** Test seam: per-process state must not leak between test files. */
export function resetPackageDocsState() {
  lookupsThisProcess = 0;
  cache.clear();
}

/**
 * npm's own name grammar, narrowed.
 *
 * ⚠️ NARROWED BECAUSE npm's REAL GRAMMAR MATCHES ORDINARY ENGLISH. npm accepts
 * any lowercase string, so `the`, `install`, `error` and `component` are all
 * syntactically valid package names — and several of them are REAL published
 * packages. A grammar-only extractor would fire a registry lookup on almost
 * every search and occasionally prepend a confident, irrelevant fact about a
 * squatted one-star package to an unrelated question. That is worse than not
 * looking: it is noise wearing the costume of evidence.
 */
export function isPackageNameShaped(token) {
  const t = String(token ?? '');
  if (!t || t.length > MAX_NAME_CHARS) return false;
  if (t.startsWith('@')) return /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(t);
  return /^[a-z0-9][a-z0-9._-]*$/.test(t);
}

/**
 * ⚠️ THE STOPLIST IS THE WHOLE DESIGN, so it is stated rather than buried.
 *
 * These are words that appear in coding questions AND are published npm
 * packages. Every one of them was checked by hand against the reason it is
 * here, because a false positive here is a wrong fact prepended to a correct
 * search — the single most expensive failure mode this module has.
 */
const NOT_A_LOOKUP = new Set([
  // ordinary English that happens to be squatted on npm
  'a', 'an', 'and', 'the', 'to', 'in', 'of', 'for', 'from', 'with', 'without',
  'is', 'it', 'this', 'that', 'how', 'what', 'why', 'when', 'not', 'no', 'or',
  /**
   * ⚠️ THE INTERROGATIVES AND AUXILIARIES EARN THEIR PLACE. Once a context
   * marker fires, the FIRST admissible token is taken — so "which React
   * version has the new API" returned `which`. A marker makes the query
   * eligible; it does not make its filler words into package names.
   */
  'which', 'who', 'where', 'whose', 'has', 'have', 'had', 'been', 'be', 'am',
  'are', 'was', 'were', 'will', 'would', 'should', 'shall', 'can', 'could',
  'may', 'might', 'must', 'but', 'so', 'than', 'then', 'there', 'here', 'they',
  'them', 'their', 'its', 'our', 'your', 'more', 'most', 'less', 'very', 'just',
  'only', 'also', 'still', 'even', 'again', 'now', 'after', 'before', 'while',
  'about', 'into', 'over', 'under', 'between', 'each', 'both', 'some', 'many',
  'much', 'few', 'other', 'another', 'same', 'such', 'own', 'first', 'last',
  'need', 'want', 'like', 'work', 'works', 'working', 'change', 'changed',
  'do', 'does', 'use', 'using', 'add', 'set', 'get', 'make', 'new', 'old',
  'best', 'my', 'me', 'you', 'we', 'all', 'any', 'one', 'two', 'up', 'out',
  // coding vocabulary that is also a package
  'error', 'errors', 'test', 'tests', 'build', 'run', 'install', 'import',
  'export', 'function', 'class', 'type', 'types', 'config', 'options', 'option',
  'component', 'components', 'server', 'client', 'api', 'app', 'code', 'file',
  'files', 'path', 'string', 'number', 'object', 'array', 'promise', 'async',
  'await', 'module', 'package', 'version', 'latest', 'deprecated', 'docs',
  'documentation', 'example', 'examples', 'usage', 'syntax', 'method', 'props',
  'state', 'hook', 'hooks', 'route', 'routes', 'schema', 'query', 'mutation',
  'style', 'styles', 'css', 'html', 'json', 'yaml', 'env', 'log', 'logs',
  // the runtimes and languages — asking about them is not asking about a package
  'node', 'nodejs', 'npm', 'yarn', 'pnpm', 'bun', 'deno', 'python', 'go',
  'rust', 'ruby', 'java', 'php', 'javascript', 'typescript', 'shell', 'bash',
  'http', 'https', 'url', 'uri', 'port', 'header', 'headers', 'body', 'response',
  // the context markers below — a word that SIGNALS a library question is not
  // itself the library, and leaving them out returned "migrate" for
  // "migrate from moment to date-fns".
  'library', 'sdk', 'framework', 'release', 'releases', 'changelog', 'migrate',
  'migration', 'upgrade', 'upgrading', 'breaking', 'changes', 'change', 'since',
]);

/**
 * ── ⚠️⚠️⭐ THE TWO-SIGNAL RULE, AND WHY THE OBVIOUS ONE FAILED ──────────────
 *
 * The first version of this extractor accepted any lowercase non-stoplist
 * token of four characters or more. Its own tests killed it inside a minute:
 * it returned `failing` for *"why is this test failing"*, `callback` for
 * *"Should I use Promise or callback"*, `http` for *"use ky for http"* — and
 * `email` for *"zod email validation v4"*, missing the actual library because
 * `zod` is three characters.
 *
 * ⚠️ AND THOSE ARE NOT HARMLESS MISSES. `email`, `callback` and `http` are all
 * REAL published packages, so every one of them resolves 200 and prepends a
 * confident, authoritative-looking fact about the wrong thing. A 404 costs
 * nothing; a wrong fact gets repeated by the model.
 *
 * ⭐ THE FIX IS TO STOP GUESSING FROM WORD SHAPE AND REQUIRE EVIDENCE, of which
 * there are exactly two admissible kinds:
 *
 *   STRUCTURAL — `@scope/name`, or a hyphen or dot inside the token. English
 *   prose does not produce `date-fns`, `ts-node` or `socket.io`. Sufficient on
 *   its own, and preferred over position because it is stronger evidence than
 *   "it came first".
 *
 *   CONTEXTUAL — the QUERY names a library concern (`v4`, `version`, `docs`,
 *   `api`, `deprecated`, `install`, `import`, `migrate`…). Only then is a bare
 *   lowercase token read as a package name, and only the first one.
 *
 * ⚠️ THIS IS DELIBERATELY TOO STRICT, and the direction matters. "express
 * middleware order" gets no lookup, because nothing in it distinguishes a
 * package question from a prose one. The cost of being strict is ONE
 * un-enriched search that the model can still answer by reading a result. The
 * cost of being loose is a wrong fact printed above the results in the position
 * reserved for the authoritative line.
 */
const CONTEXT_MARKER = /\bv\d|\bversion\b|\bversions\b|\bdocs?\b|\bdocumentation\b|\bapi\b|\bsdk\b|\blibrary\b|\bpackage\b|\bnpm\b|\bimport\b|\brequire\b|\binstall\b|\bdeprecat|\bmigrat|\bupgrad|\blatest\b|\brelease|\bchangelog\b|\bbreaking\b/i;

/**
 * Which token in this query, if any, is worth one registry GET?
 *
 * ⚠️ RETURNS AT MOST ONE. A query like "migrate from moment to date-fns" names
 * two packages and the honest answer is both — but two lookups per search is
 * how a bounded enrichment becomes a crawl, and the FIRST distinctive token is
 * overwhelmingly the subject of the question. One fact, cheaply, beats four
 * facts and a latency complaint.
 *
 * ⭐ SCOPED NAMES WIN OUTRIGHT. `@tanstack/react-query` cannot be an English
 * word, so it is unambiguous evidence and is preferred over everything else in
 * the query regardless of position.
 */
export function packageCandidate(query) {
  const raw = String(query ?? '');
  const tokens = raw
    .split(/[^@/A-Za-z0-9._-]+/)
    .map((t) => t.replace(/[.,;:!?)\]]+$/, ''))
    .filter(Boolean);

  /** Capitalised words are prose. `React` in a sentence is not `react` on npm. */
  const usable = tokens.filter((t) => t === t.toLowerCase() && isPackageNameShaped(t) && !NOT_A_LOOKUP.has(t));

  // STRUCTURAL evidence, strongest first. Beats position: a hyphen is a fact,
  // "it came first" is a guess.
  const scoped = usable.find((t) => t.startsWith('@'));
  if (scoped) return scoped;
  const punctuated = usable.find((t) => /[-.]/.test(t) && !/^[-.]|[-.]$/.test(t));
  if (punctuated) return punctuated;

  // CONTEXTUAL evidence. Only now is a bare word admissible, and only the first.
  if (!CONTEXT_MARKER.test(raw)) return null;
  return usable.find((t) => t.length >= 2) ?? null;
}

/**
 * ⚠️ THE URL IS BUILT FROM AN ENCODED NAME, not interpolated raw. A scoped
 * name contains `/`, and `@scope/name` must reach the registry as
 * `@scope%2fname` or the path resolves to a different document. Getting this
 * wrong returns a plausible 404 that reads as "no such package".
 */
export function registryUrl(name, version) {
  const encoded = String(name).replace(/\//g, '%2f');
  return `${REGISTRY}/${encoded}/${encodeURIComponent(version || 'latest')}`;
}

async function defaultFetchImpl(url, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      redirect: 'follow',
      headers: { accept: 'application/json', 'user-agent': 'acuvo-code' },
    });
    return { status: res.status, body: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

/** `repository` is a string on old packages and an object on new ones. */
function repoUrl(repository) {
  const raw = typeof repository === 'string' ? repository : repository?.url;
  if (!raw) return null;
  return String(raw).replace(/^git\+/, '').replace(/\.git$/, '');
}

/**
 * Ask npm what is CURRENT, and whether the maintainer has disowned it.
 *
 * ⚠️ EVERY FAILURE IS SOFT AND NAMED. This is an enrichment on somebody else's
 * search: a registry that is down, slow, or has never heard of the token must
 * degrade to "no package fact today" and let the search proceed untouched. An
 * enrichment that can fail a search is a liability, not a feature.
 *
 * @returns {Promise<{ok:true,name:string,version:string,deprecated:string|null,
 *   docsUrl:string|null,repository:string|null,description:string|null}
 *   | {ok:false,reason:string}>}
 */
export async function packageDocs(params = {}) {
  const name = String(params.name ?? '').trim();
  const version = params.version ? String(params.version).trim() : '';
  const fetchImpl = params.fetchImpl || defaultFetchImpl;
  const timeoutMs = Number(params.timeoutMs) || PACKAGE_TIMEOUT_MS;

  if (!isPackageNameShaped(name)) return { ok: false, reason: `"${name}" is not a valid npm package name` };

  const key = `${name}@${version || 'latest'}`;
  if (cache.has(key)) return cache.get(key);
  if (lookupsThisProcess >= MAX_LOOKUPS_PER_PROCESS) {
    return { ok: false, reason: `this run has already made ${MAX_LOOKUPS_PER_PROCESS} registry lookups, which is the cap` };
  }
  lookupsThisProcess += 1;

  let res;
  try {
    res = await fetchImpl(registryUrl(name, version), timeoutMs);
  } catch (e) {
    const why = e?.name === 'AbortError' ? `no answer within ${timeoutMs}ms` : String(e?.message || e);
    return { ok: false, reason: `the npm registry could not be reached (${why})` };
  }

  const status = Number(res?.status ?? 0);
  /**
   * ⚠️ 404 IS AN ANSWER, AND IT IS NOT "THE PACKAGE IS GONE". It means the
   * token was not a package name — which is the EXPECTED outcome for a
   * heuristic extractor and must stay silent rather than telling the model that
   * a library it asked about does not exist.
   */
  if (status === 404) return { ok: false, reason: `npm has no package called "${name}"` };
  if (status < 200 || status >= 300) return { ok: false, reason: `the npm registry answered HTTP ${status}` };

  let doc;
  try {
    doc = JSON.parse(String(res?.body ?? ''));
  } catch (e) {
    return { ok: false, reason: `the registry response could not be read: ${String(e?.message || e)}` };
  }
  if (!doc || typeof doc !== 'object' || !doc.version) {
    return { ok: false, reason: `the registry answered without a version for "${name}"` };
  }

  const out = {
    ok: true,
    name: String(doc.name || name),
    version: String(doc.version),
    /**
     * ⭐ THE FIELD THIS WHOLE MODULE EXISTS FOR. npm stores it as a STRING when
     * set and omits it otherwise; some publishers set it to `true`, which
     * carries no message but is still a deprecation and must not be dropped.
     */
    deprecated: typeof doc.deprecated === 'string'
      ? doc.deprecated
      : (doc.deprecated === true ? 'the maintainer has marked this package deprecated' : null),
    docsUrl: doc.homepage ? String(doc.homepage) : null,
    repository: repoUrl(doc.repository),
    description: doc.description ? String(doc.description) : null,
  };
  cache.set(key, out);
  return out;
}

/**
 * Render the fact for the model — short, and it must survive being skimmed.
 *
 * ⚠️ WRITTEN AS AN ORDER, NOT AS A NOTE. The measured behaviour is that a model
 * reads a fact, agrees with it, and then writes the code it was always going to
 * write. So a deprecation does not say "this package is deprecated"; it says
 * DO NOT USE IT and names what to do instead. The repo has already paid for
 * this lesson twice — a capability the model is merely INFORMED of behaves
 * exactly like one it was never given.
 */
export function formatPackageDocs(doc) {
  if (!doc?.ok) return '';
  const lines = [];
  if (doc.deprecated) {
    lines.push(`⚠️ DEPRECATED — npm reports ${doc.name} as deprecated: ${doc.deprecated}`);
    lines.push('   Do NOT write new code against it. Find the current replacement before continuing.');
  }
  lines.push(
    `npm registry (authoritative, checked just now): ${doc.name} is currently at ${doc.version}.`,
  );
  /**
   * ⚠️ THE DISCLAIMER IS NOT BOILERPLATE. This module never sees the project's
   * package.json, so "current on npm" and "the version this repo installs" are
   * two different numbers. Saying which one this is turns a possible wrong
   * answer into a correct one the model can act on.
   */
  lines.push(
    '   That is the version npm publishes today, NOT necessarily the one this project pins —'
    + ' check package.json if the difference would change the code you write.',
  );
  if (doc.description) lines.push(`   ${doc.description}`);
  if (doc.docsUrl) lines.push(`   Docs: ${doc.docsUrl}  ← fetch_url this before coding against the API.`);
  else if (doc.repository) lines.push(`   Source: ${doc.repository}  ← fetch_url this before coding against the API.`);
  return lines.join('\n');
}

/** Kept for the doctor: what this capability needs, and what it costs. */
export function packageDocsChecks() {
  return {
    label: 'npm package facts',
    endpoint: REGISTRY,
    needsKey: false,
    note: `keyless and free. One ~4KB GET per distinct package, at most ${MAX_LOOKUPS_PER_PROCESS} per run, cached per process.`,
  };
}
