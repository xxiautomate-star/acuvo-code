/**
 * ── ⭐⭐⭐ THE MULTIPLIER: npm IS THE MCP REGISTRY ───────────────────────────
 *
 * Roman handed over a list of ~120 MCP servers he wants reachable — GitHub,
 * Playwright, Notion, Slack, Stripe, Supabase, Blender, Postgres, Sentry,
 * Linear, Firecrawl, Exa, ElevenLabs, fal.ai and on and on.
 *
 * ⚠️ THE WRONG ANSWER IS A HARDCODED LIST OF 120. It is stale the week it ships,
 * it is ours to maintain forever, and it silently omits every server published
 * after we wrote it — which is the "capability present but unreachable" defect
 * this codebase keeps finding, in registry form.
 *
 * ⭐ THE RIGHT ANSWER IS THAT SOMEBODY ALREADY MAINTAINS THIS LIST. Every MCP
 * server ships on npm, and npm has a public search API needing no key and no
 * account. Measured: `modelcontextprotocol server` returns hundreds of thousands
 * of packages. So discovery is a QUERY, not a data file, and a server published
 * tomorrow is findable tomorrow.
 *
 * `KNOWN_SERVERS` in `mcp-add.mjs` stays as the CURATED head — eight we have
 * actually run, with hand-written blurbs and the argument quirks that matter.
 * This module is the long tail behind it.
 *
 * ── ⚠️ WHAT THIS DELIBERATELY DOES NOT DO ───────────────────────────────────
 *
 * It does not install anything, and it does not rank by trust. An MCP server is
 * a program that runs on the user's machine with their privileges, and a search
 * result is not an endorsement — the output says so, every time. Publishing a
 * package named `slack-mcp` costs nothing and anyone may do it.
 */

import { KNOWN_SERVERS } from './mcp-add.mjs';
/**
 * ⭐ THE SAME ADVISORY THE ADD PATH CONSULTS. Two commands disagreeing about
 * whether a package is safe is worse than neither of them knowing: `search`
 * would keep recommending exactly what `add` refuses, and the user would read
 * the refusal as a bug in `add`.
 */
import { packageAdvisory } from './mcp-defaults.mjs';

/** npm's public search endpoint. No key, no account, no rate limit worth naming. */
const SEARCH_URL = 'https://registry.npmjs.org/-/v1/search';

/** How long to wait before deciding the network is not going to answer. */
export const SEARCH_TIMEOUT_MS = 12_000;

/**
 * Terms that identify an MCP server rather than a library that mentions MCP.
 *
 * ⚠️ SEARCHING THE BARE QUERY FINDS THE WRONG THINGS. "figma" returns the Figma
 * SDK, plugin helpers and a hundred unrelated packages; the user asked which MCP
 * SERVER exists for Figma. The qualifier is what makes the answer useful.
 */
const QUALIFIER = 'mcp server';

/**
 * Is this package plausibly an MCP server, rather than something that merely
 * mentions the protocol?
 *
 * ⚠️ NAME-BASED, AND DELIBERATELY LOOSE. The ecosystem has settled on three
 * shapes — `@modelcontextprotocol/server-x`, `x-mcp-server`, `x-mcp` — but
 * plenty of good servers sit outside them, so a description match counts too.
 * Being too strict here hides working servers, which is the failure that matters.
 */
export function looksLikeServer(pkg) {
  const name = String(pkg?.name ?? '').toLowerCase();
  const description = String(pkg?.description ?? '').toLowerCase();
  if (name.startsWith('@modelcontextprotocol/server')) return true;
  if (/\bmcp\b/.test(name) || name.includes('-mcp')) return true;
  return /model context protocol|\bmcp\b/.test(description) && /server/.test(description);
}

/**
 * Rank so the thing the user meant is first.
 *
 * ⚠️ npm's own ordering optimises for downloads, which buries a small, correct,
 * official server under a popular fork. Official scope wins, then an exact
 * subject match in the name, then npm's score as a tiebreak.
 */
export function scoreResult(pkg, subject) {
  const name = String(pkg?.name ?? '').toLowerCase();
  const want = String(subject ?? '').toLowerCase().trim();
  let score = Number(pkg?.score ?? 0);

  /**
   * ⚠️ `@modelcontextprotocol/server` IS THE SDK, NOT A SERVER, and it matched
   * every single query — it outranked `@stripe/mcp` for "stripe" until this
   * existed. The official-scope bonus belongs to `server-<something>`, never to
   * the bare package a developer imports to BUILD one.
   */
  if (name === '@modelcontextprotocol/server' || name === '@modelcontextprotocol/sdk') return -1;
  /**
   * ⭐ 30, NOT 10. `@modelcontextprotocol/server-*` IS the reference
   * implementation — if one exists for the subject it is the answer, and no
   * amount of a third-party fork's download count should outrank it.
   */
  if (name.startsWith('@modelcontextprotocol/server-')) score += 30;

  /**
   * ⭐ A VENDOR'S OWN SCOPE IS THE STRONGEST SIGNAL THERE IS. `@stripe/mcp` and
   * `@notionhq/notion-mcp-server` are published by the company whose API they
   * wrap — that outranks a popular third-party fork every time, and it is
   * exactly the trust signal npm's download-weighted score hides.
   */
  /**
   * ⚠️ THE SCOPE STARTS WITH the subject rather than equalling it. Notion
   * publishes under `@notionhq/`, not `@notion/` — an exact-match rule ranked a
   * third-party `notion-mcp-server` above Notion's own package.
   */
  const scope = name.startsWith('@') ? name.slice(1, name.indexOf('/')) : '';
  if (want && scope && scope.startsWith(want)) score += 15;
  if (want && name.includes(want)) score += 5;
  /**
   * A package whose name IS the subject plus a marker is almost always the one.
   *
   * ⚠️ COMPARED ON THE BASENAME, NOT THE FULL NAME. Matching the whole string
   * gave the unscoped `notion-mcp-server` this bonus and denied it to Notion's
   * OWN `@notionhq/notion-mcp-server`, which then lost the ranking 25 to 20 —
   * the official package pushed below a third-party one by a scope it earned.
   */
  const basename = name.includes('/') ? name.slice(name.indexOf('/') + 1) : name;
  if (want && (basename === `${want}-mcp` || basename === `${want}-mcp-server` || basename === `mcp-server-${want}` || basename === `server-${want}`)) {
    score += 20;
  }
  return score;
}

/**
 * Find MCP servers for a subject.
 *
 * @param subject what the user asked for, e.g. "notion" or "stripe"
 * @param fetchImpl injected for tests; the real one is global fetch
 * @returns `{ ok, results, error }` — never throws
 */
export async function searchServers(subject, { fetchImpl = fetch, limit = 8, timeoutMs = SEARCH_TIMEOUT_MS } = {}) {
  const want = String(subject ?? '').trim();
  if (!want) return { ok: false, results: [], error: 'say what you are looking for, e.g. `acuvo mcp search notion`' };

  const url = `${SEARCH_URL}?text=${encodeURIComponent(`${want} ${QUALIFIER}`)}&size=25`;
  /**
   * ⚠️ THE TIMEOUT IS OURS, NOT THE RUNTIME'S. A hung registry must not hang a
   * CLI session; `AbortController` is the only thing that reliably bounds fetch.
   */
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res?.ok) return { ok: false, results: [], error: `npm search answered ${res?.status ?? 'nothing'}` };
    const body = await res.json();
    const objects = Array.isArray(body?.objects) ? body.objects : [];

    /**
     * ── ⚠️⚠️ A RESULT LIST IS A RECOMMENDATION, WHATEVER THE DISCLAIMER SAYS ──
     *
     * This module's own header says a search result is not an endorsement, and
     * that is true right up until `formatResults` prints
     * `Add one: acuvo mcp add <top result>`. Measured 2026-08-25 with the real
     * npm payload shape: `acuvo mcp search git` LISTED `mcp-server-git` — the
     * dependency-confusion canary `mcp-defaults.mjs` researched and removed from
     * the catalogue in 2026-08-14 — with the package's own
     * *"Security research canary"* blurb as the only signal that anything was
     * wrong, which reads to a hurried user as a description of a feature.
     *
     * ⭐ WITHHELD, AND SAID OUT LOUD. Dropping it silently would hide the one
     * fact worth having; leaving it ranked would keep offering it. So it leaves
     * the ranked list — nothing the `Add one:` line can name — and is reported
     * separately with the reason, which is strictly more information than the
     * version that listed it.
     *
     * ⚠️ This screens only what `PACKAGE_ADVISORIES` has actually checked. It is
     * not a safety guarantee about anything else in the list, and the standing
     * "these are not vetted by us" warning stays exactly as it was.
     */
    const withheld = [];
    const results = objects
      .map((o) => o?.package)
      .filter((p) => p && looksLikeServer(p))
      .filter((p) => {
        const advisory = packageAdvisory(p.name);
        if (advisory?.severity === 'refuse') {
          withheld.push({ name: String(p.name), message: advisory.message });
          return false;
        }
        return true;
      })
      .map((p) => {
        const advisory = packageAdvisory(p.name);
        return {
          name: String(p.name),
          description: String(p.description ?? '').slice(0, 100),
          version: String(p.version ?? ''),
          score: scoreResult(p, want),
          ...(advisory ? { advisory: advisory.message } : {}),
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    /**
     * ── ⭐⭐ THE CURATED HEAD LEADS, ALWAYS ────────────────────────────────
     *
     * Ranking npm by heuristic gets the obvious cases right and then plateaus —
     * `@iflow-mcp/stripe-mcp` outranked `@stripe/mcp` on one scoring rule and
     * the fix for that broke another. Chasing it further is hand-building a
     * search engine, which is precisely the work we should not be doing.
     *
     * So the eight servers we have actually RUN are stated as ours, marked, and
     * placed first; npm supplies the long tail behind them. Trust comes from
     * having used the thing, never from a score.
     */
    const curatedName = KNOWN_SERVERS?.[want]?.package;
    if (curatedName && !results.some((r) => r.name === curatedName)) {
      results.unshift({
        name: curatedName,
        description: `${KNOWN_SERVERS[want].blurb} — verified by us`,
        version: '',
        score: Number.MAX_SAFE_INTEGER,
        curated: true,
      });
      results.length = Math.min(results.length, limit);
    } else if (curatedName) {
      const i = results.findIndex((r) => r.name === curatedName);
      results[i] = { ...results[i], description: `${KNOWN_SERVERS[want].blurb} — verified by us`, curated: true };
      results.unshift(...results.splice(i, 1));
    }

    if (results.length === 0) {
      return {
        ok: true,
        results: [],
        withheld,
        error: `no MCP server found for "${want}". It may not exist yet — or it ships under a name that does not mention MCP, in which case \`acuvo mcp add <package>\` still works.`,
      };
    }
    return { ok: true, results, withheld };
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    return {
      ok: false,
      results: [],
      error: aborted ? `npm search did not answer within ${Math.round(timeoutMs / 1000)}s` : String(err?.message ?? err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What the user sees.
 *
 * ⚠️ IT ALWAYS SAYS THESE ARE UNVETTED. An MCP server runs on this machine with
 * the user's privileges, and anyone may publish a package called `slack-mcp`.
 * A search result is a search result, not a recommendation, and the one line
 * that says so is the difference between a tool and a supply-chain footgun.
 */
export function formatResults(out, subject) {
  /**
   * ⚠️ THE WITHHELD BLOCK SURVIVES THE EARLY RETURNS. A query whose ONLY hit was
   * a refused package lands in the `error` branch ("no MCP server found"), and
   * that is exactly the case where the user most needs to be told why — without
   * it they would search again, find the same package on npm directly, and add
   * it by hand believing we simply had not indexed it.
   */
  const withheldLines = (out?.withheld ?? []).flatMap((w) => [
    '',
    `  ⛔ Withheld: ${w.name}`,
    `     ${w.message}`,
  ]);

  if (!out?.ok && out?.error) return [`  ${out.error}`, ...withheldLines].join('\n');
  if (out.error) return [`  ${out.error}`, ...withheldLines].join('\n');
  const lines = out.results.map((r) => [
    `  ${r.name}${r.version ? `  ${r.version}` : ''}`,
    `      ${r.description || '(no description)'}`,
    ...(r.advisory ? [`      ⚠ ${r.advisory}`] : []),
  ].join('\n'));
  return [
    `  MCP servers matching "${subject}" — from the npm registry, live:`,
    '',
    ...lines,
    ...withheldLines,
    '',
    '  ⚠ These are published packages, not vetted by us. An MCP server runs on this',
    '    machine with your privileges — read what it does before adding it.',
    '',
    `  Add one:  acuvo mcp add ${out.results[0]?.name ?? '<package>'}`,
  ].join('\n');
}
