/**
 * ── ⭐⭐ THE AGENT COULD START FROM AN ISSUE AND COULD NOT PARTICIPATE ────────
 *
 * MEASURED 2026-08-15, on this machine: `gh` v2.90.0 is installed at
 * `C:\Program Files\GitHub CLI\gh.EXE` and authenticated (keyring, account
 * `xxiautomate-star`, scopes `repo, workflow, read:org, gist, user`). And the
 * MODEL had no GitHub verb at all. `github.mjs` fetches ONE issue over REST at
 * startup, turns it into the task, and that is the entire surface: mid-run the
 * agent cannot list the other issues, cannot read the pull request it is being
 * asked to address, cannot read a single review comment, and cannot see why CI
 * went red. "Fix the review feedback" and "the build is failing, fix it" — the
 * two most common follow-ups a coding agent gets — were both unanswerable.
 *
 * ── ⚠️ WHY THIS IS NOT `gh` ADDED TO `ALLOWED_BINARIES` ─────────────────────
 * `git.mjs` already made this argument and it applies here with less mercy, so
 * this file follows its shape rather than inventing a second one:
 *
 *   1. **The surface is enormous and mostly WRITE.** `gh pr merge`, `gh issue
 *      close`, `gh release create`, `gh secret set`, `gh repo delete`, `gh
 *      workflow run` — and `gh api -X POST <anything>`, which is a universal
 *      write to every endpoint GitHub has. A flag denylist for a program whose
 *      last subcommand is "run an arbitrary HTTP method against an arbitrary
 *      path" is not a promise anybody can keep.
 *   2. **Every write is PUBLIC and IRREVERSIBLE-ISH.** A wrong file write is
 *      undone by writing the file again. A wrong comment on someone's issue is
 *      an email to everyone watching the repository, and deleting it does not
 *      un-send that. `github.mjs`'s header already refused to push or open a PR
 *      for exactly this reason; this file is the same policy, enforced instead
 *      of merely intended.
 *
 * ⭐ SO `gh` IS EXPOSED AS STRUCTURED VERBS, and the argv for each one is a
 * LITERAL IN THIS FILE. The model supplies parameters — a number, a limit, a
 * label — and `planGh` builds the exact argument vector. `pr merge`, `issue
 * close`, `api`, `secret set` are not refused by a check that could be
 * mis-written: THEY ARE NOT EXPRESSIBLE. There is no path from a model-authored
 * string to a subcommand it was not given, because the subcommand words never
 * come from the model at all.
 *
 * ── ⭐ THE SURFACE, AND THE ARGUMENT FOR EACH ONE ───────────────────────────
 * · `issue list`   — the "what is there to work on" question. Without it the
 *                    only way in is a human typing a number.
 * · `issue view`   — ⚠️ arguably duplicates `github.mjs:fetchIssue`. Kept:
 *                    `fetchIssue` is reachable only from `--issue N` at startup,
 *                    returns a fixed field set, and refuses a PR outright. This
 *                    is the mid-run "what does the linked issue actually say".
 * · `pr list`      — cheap, and the only way to find "the PR for this branch".
 * · `pr view`      — ⭐ THE HIGHEST-VALUE READ IN THE FILE. `reviews`,
 *                    `latestReviews` and `comments` are what "address the review
 *                    feedback" means. Nothing else in this package can see them.
 * · `pr diff`      — reviewing a change that is not ours. ⚠️ The one output that
 *                    is routinely enormous; see the cap below.
 * · `pr checks`    — one call for "is CI green", against `run list` + `run view`
 *                    which is two calls and a join.
 * · `run list`     — which CI runs exist and which are red.
 * · `run view`     — the run and its jobs.
 * · `run view --log-failed` — ⭐ the reason "fix the failing build" works at
 *                    all. ⚠️ `--log-failed`, never `--log`: a full CI log is
 *                    megabytes of setup noise, and the model pays per token.
 *
 * ── ⚠️ AND WHAT WAS ARGUED FOR AND LEFT OUT ─────────────────────────────────
 * · `gh api` — REFUSED, permanently. It is read-only only until the model adds
 *   `-X POST`, and no validator can enumerate what an arbitrary API path does.
 *   The whole point of structured verbs is that the dangerous form is absent.
 * · `gh search issues/prs/code` — genuinely read-only and genuinely useful, but
 *   it is a fourth noun with its own query language, and this package's
 *   signature defect is capability that is built and never reached. Three nouns
 *   proven end to end beat four half-tested ones. `--search` on list covers most
 *   of it already.
 * · `gh release view`, `gh repo view` — read-only, low value per schema token.
 *   Left out to hold the offer at three schemas.
 * · `gh pr checkout` — reads like a read. It is not: it mutates the working
 *   tree, and `git.mjs` deliberately has no checkout for that exact reason.
 */

import { MAX_CAPTURED_CHARS, clampOutput, scrubEnvironment, spawnBounded } from './command.mjs';
import { resolveOnPath } from './lsp.mjs';
import { validateBranchName } from './git.mjs';

/**
 * @typedef {{ ok: false, error: string }} GhRefused
 * @typedef {{ ok: true, verb: string, args: string[], json: boolean, maxChars: number }} GhPlan
 */

/** The API behind gh is fast or broken; a long wait here teaches nothing. */
export const GH_TIMEOUT_MS = 30_000;
/**
 * ── ⚠️⚠️ THE REAL CEILING IS `spawnBounded`'s, NOT OURS, AND I SHIPPED THE
 *          WRONG NUMBERS FOR IT UNTIL A TEST SAID SO ─────────────────────────
 *
 * `spawnBounded` clamps each stream to `MAX_CAPTURED_CHARS` (8,000, at
 * `command.mjs:80`) BEFORE it ever returns. So this file's first draft, with a
 * 16,000-character "generous cap" for a diff, was writing a number that can
 * never be reached: a 200KB pull-request diff arrived already cut to 8,000, this
 * module's own cap then found nothing to trim, and the result went back with
 * `truncated: false`. A confident "here is the diff" about 4% of the diff.
 *
 * ⭐ TWO FIXES, AND BOTH MATTER. The text caps are now DERIVED from the capture
 * buffer, so they cannot silently become fiction again if that number changes.
 * And `runGh` reads `stdoutOmitted`/`stdoutProduced` back out of `spawnBounded`
 * and folds them into `truncated`/`omitted` — because a cut made upstream is
 * still a cut, and this package treats silent truncation as the worst class of
 * bug it can ship.
 *
 * ⚠️ JSON IS DIFFERENT AND IS *NOT* CAPPED AT 8,000. `capJsonPayload` re-emits
 * the parsed value with two-space indentation, and gh prints compact JSON — so
 * 8,000 captured characters routinely become 15,000+ pretty-printed ones. That
 * cap is reachable and is doing real work.
 */
export const MAX_GH_OUTPUT_CHARS = 12_000;
/**
 * ⚠️ A PR DIFF CANNOT BE SHOWN WHOLE BY ANY CAP. A 40-file refactor is hundreds
 * of kilobytes; the capture buffer is 8,000 characters. So the cap's job is not
 * to be generous — it cannot be — it is to be HONEST and to name the way out.
 * See `capNote`, and `capTextPayload`'s two different sentences.
 */
export const MAX_GH_DIFF_CHARS = MAX_CAPTURED_CHARS;
/** A failed-step log is the one output where the TAIL is the answer. */
export const MAX_GH_LOG_CHARS = MAX_CAPTURED_CHARS;
/**
 * ── ⚠️ THE LIMITS ARE MEASURED, AND THE FIRST DRAFT'S WERE FANTASY ──────────
 *
 * Draft: default 30, maximum 100. Measured against cli/cli on 2026-08-15, at
 * the default of 30 and with these exact field sets:
 *
 *     gh issue list --limit 30  -> 16,393 chars   (546 per issue)
 *     gh pr    list --limit 30  -> 16,851 chars   (562 per PR)
 *     gh run   list --limit 30  ->  8,933 chars   (298 per run)
 *     capture ceiling                8,000
 *
 * ⭐ So the DEFAULT overflowed on every noun, and the advertised maximum of 100
 * was a number that could never be delivered — roughly 56,000 characters into an
 * 8,000-character pipe. Offering it is not generosity, it is a promise the tool
 * breaks silently.
 *
 * ⚠️ The per-item cost is mostly `labels` (223/item — GitHub returns id, name,
 * description AND colour per label) and `author` (89/item, a nested object).
 * Both are kept: "which issue should I pick up" is unanswerable without them.
 * The LIMIT is what moves instead. 10 × 562 ≈ 5,600, which fits with headroom.
 *
 * ⭐ Above ~13 items the result is still returned, now truncated and loudly
 * labelled rather than lost — so the maximum is a soft, honest 30 rather than a
 * refusal, and someone who explicitly asks for 30 is told what they got.
 */
export const MAX_GH_LIMIT = 30;
export const DEFAULT_GH_LIMIT = 10;
export const MAX_GH_SEARCH_CHARS = 200;
export const MAX_GH_LABELS = 10;

/**
 * ── ⚠️ THE FIELD LISTS ARE MEASURED, NOT REMEMBERED ─────────────────────────
 *
 * Every name below was read out of `gh <cmd> --json zzz` on gh 2.90.0, which
 * prints the available fields when the requested one does not exist. That
 * matters because a single wrong field name makes the WHOLE call fail with
 * "Unknown JSON field" — not degrade, fail — so a remembered field list is a
 * verb that is dark on every machine until someone runs it.
 *
 * ⭐ AND `--json` AT ALL RATHER THAN SCRAPING gh's PROSE. gh's human output is
 * a table tuned for a terminal: it truncates titles to the window width, prints
 * relative dates ("about 2 hours ago") that cannot be compared, and drops the
 * body entirely. Structured output survives all three, and it is the difference
 * between the model guessing at a review comment and reading it.
 */
/**
 * ── ⚠️⚠️ THE FIELD LISTS ARE SPLIT, AND ONLY THE REAL RUN SHOWED WHY ────────
 *
 * The first draft asked `view` for everything at once — metadata, body, reviews
 * AND comments. Every unit test passed. Then the first end-to-end call against a
 * real public repository (cli/cli #9000, 2026-08-15):
 *
 *     gh issue view 9000 --json <the whole draft list>  -> 12,320 chars
 *     gh pr    view 9000 --json <the whole draft list>  -> 17,403 chars
 *     capture ceiling (MAX_CAPTURED_CHARS)              ->  8,000 chars
 *
 * ⭐ So the two most valuable verbs in the file failed on an ORDINARY issue —
 * not a pathological one — and the honest "ask for less" error I had written was
 * advice with no way to follow it: there is no unit smaller than one issue.
 * Built, tested, green, and DARK on every real repository. That is this
 * package's signature defect and no unit test was ever going to find it.
 *
 * ⭐ MEASURED PER FIELD, which is what made the fix obvious rather than a guess:
 *     body 6,949 · comments 4,971 · reviews 2,609 · latestReviews 2,096
 *     … and ALL the metadata together (number, title, state, labels, author,
 *       refs, mergeable, counts, url) ≈ 500.
 *
 * Three fields are the entire problem. So the heavy content moves to its own
 * action — `comments` — and `view` keeps the body plus the cheap metadata. Two
 * calls that work beat one call that cannot.
 *
 * ⚠️ `latestReviews` IS DROPPED ENTIRELY: it is a subset of `reviews` (the most
 * recent per reviewer), and 2,096 characters to repeat information already in
 * the response is the difference between `pr comments` fitting and not.
 */
export const ISSUE_LIST_FIELDS = 'number,title,state,labels,author,assignees,createdAt,updatedAt,url';
export const ISSUE_VIEW_FIELDS = 'number,title,state,stateReason,body,labels,author,assignees,milestone,createdAt,url';
/** ⭐ The discussion, on its own budget. An issue's answer is usually in here. */
export const ISSUE_COMMENTS_FIELDS = 'number,title,comments';
export const PR_LIST_FIELDS = 'number,title,state,isDraft,author,headRefName,baseRefName,labels,createdAt,updatedAt,url';
export const PR_VIEW_FIELDS = 'number,title,state,isDraft,body,author,headRefName,baseRefName,mergeable,mergeStateStatus,reviewDecision,files,additions,deletions,changedFiles,url';
/** ⭐ THE HIGHEST-VALUE READ IN THE FILE — "address the review feedback". */
export const PR_COMMENTS_FIELDS = 'number,title,state,reviewDecision,reviews,comments';
export const PR_CHECKS_FIELDS = 'name,state,bucket,workflow,event,link,description,startedAt,completedAt';
export const RUN_LIST_FIELDS = 'databaseId,number,name,workflowName,status,conclusion,headBranch,event,createdAt,url';
export const RUN_VIEW_FIELDS = 'databaseId,number,name,workflowName,status,conclusion,headBranch,headSha,event,createdAt,jobs,url';

/** gh's own `--status` vocabulary for `run list`, copied from `gh run list --help`. */
export const RUN_STATUSES = Object.freeze([
  'queued', 'completed', 'in_progress', 'requested', 'waiting', 'pending', 'action_required',
  'cancelled', 'failure', 'neutral', 'skipped', 'stale', 'startup_failure', 'success', 'timed_out',
]);

// ───────────────────────────────────────────────────────────────────────────
// THE VALIDATORS — pure, and every refusal names the way out
// ───────────────────────────────────────────────────────────────────────────

/**
 * ── ⚠️⚠️ `--repo` ACCEPTS `[HOST/]OWNER/REPO`, AND THE HOST IS THE HOLE ─────
 *
 * Straight from `gh pr list --help`:
 *     -R, --repo [HOST/]OWNER/REPO   Select another repository
 *
 * So `repo: "evil.example.com/owner/name"` is a valid gh argument that points
 * the CLI — carrying the user's credential — at a host nobody chose. It is not
 * a shell escape, it is a documented feature, which is exactly the kind of thing
 * an argument validator is for and a character whitelist would sail past.
 *
 * ⭐ So: exactly ONE slash, and both halves are GitHub name characters. A host,
 * a URL, a `..`, an `@` and a leading `-` are all inexpressible.
 */
export function validateRepo(raw) {
  if (raw === null || raw === undefined || raw === '') return { ok: true, repo: null };
  if (typeof raw !== 'string') return { ok: false, error: 'repo must be a string like "owner/name"' };
  const repo = raw.trim();
  if (!repo) return { ok: true, repo: null };
  if (repo.includes('://') || repo.includes('@')) {
    return { ok: false, error: `"${repo}" looks like a URL. Pass just "owner/name" — the host is always github.com, because sending your credential to a host the model chose is not something this agent does.` };
  }
  const parts = repo.split('/');
  if (parts.length !== 2) {
    return {
      ok: false,
      error: parts.length > 2
        ? `"${repo}" has ${parts.length - 1} slashes. gh would read the first part as a HOST and talk to it with your credential, so only "owner/name" is accepted.`
        : `"${repo}" is not a repository. Give "owner/name", or leave repo out entirely to use the repository this workspace is in.`,
    };
  }
  for (const part of parts) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)) {
      return { ok: false, error: `"${part}" is not a GitHub owner or repository name — letters, digits, ".", "_" and "-", not starting with a dash.` };
    }
    // ⚠️ `..` is path traversal in gh's REST path building, and a repository
    // name cannot legitimately contain it.
    if (part.includes('..')) return { ok: false, error: `"${part}" contains "..", which is never part of a GitHub name.` };
  }
  return { ok: true, repo };
}

/**
 * ⚠️ AN ISSUE/PR NUMBER, AND NOT A URL. gh accepts `gh pr view <url>` and
 * `gh pr view <branch>` as well as a number — so a model that pasted
 * `https://github.com/someone-else/private/pull/1` would read a DIFFERENT
 * repository through the `repo` guard above without ever touching `--repo`.
 * A positive integer makes that shape inexpressible.
 */
/**
 * ── ⚠️⚠️ THE CEILING IS PER-NOUN, AND ONE CEILING BROKE THE CI VERBS ────────
 *
 * The first draft capped every number at 9,999,999, on the reasoning that no
 * repository has ten million issues. True — and irrelevant to the other thing
 * this validator guards. MEASURED on the first end-to-end run, 2026-08-15:
 *
 *     gh run list --repo cli/cli  ->  databaseId 31882889895   (11 digits)
 *     validateNumber(31882889895) ->  REFUSED
 *
 * ⭐ So `run view` and `run view --log-failed` — the entire "why did CI fail"
 * story, and the best argument for this whole file — were unreachable against
 * every real repository, and the refusal read "is not a real issue or pull
 * request number" about a RUN ID. A guard that fails correct work is worse than
 * no guard, and one that misnames the thing it rejected is worse still: it sends
 * the reader looking for a bug in the wrong noun.
 *
 * ⚠️ A run id is a global, monotonically increasing counter across all of
 * GitHub, so it has no small bound and never will. `MAX_RUN_ID` is set well
 * above today's ~3.2e10 while still refusing the absurd — the check is against
 * typos and overflow, not against GitHub's own numbering.
 */
export const MAX_ITEM_NUMBER = 9_999_999;
export const MAX_RUN_ID = 1e15;

export function validateNumber(raw, what = 'number', max = MAX_ITEM_NUMBER) {
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) raw = Number(raw.trim());
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw) || raw < 1) {
    return { ok: false, error: `${what} must be a positive whole number (e.g. 42). A URL or a branch name is not accepted here — use "repo" to point at another repository.` };
  }
  // ⭐ Names the parameter it rejected, not a noun it guessed at.
  if (raw > max) return { ok: false, error: `${what} ${raw} is too large to be a real ${what} (the limit is ${max}).` };
  return { ok: true, value: raw };
}

/** Clamped rather than refused: "give me 500" is a reasonable ask with an unreasonable answer. */
export function validateLimit(raw) {
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: DEFAULT_GH_LIMIT };
  const n = typeof raw === 'string' ? Number(raw.trim()) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    return { ok: false, error: `limit must be a number between 1 and ${MAX_GH_LIMIT}` };
  }
  return { ok: true, value: Math.min(Math.max(1, Math.floor(n)), MAX_GH_LIMIT) };
}

/**
 * A GitHub login, or `@me`.
 *
 * ⭐ `@me` is kept deliberately: "the pull requests assigned to me" is the
 * question a user actually asks, and gh resolves it from the authenticated
 * account rather than from anything the model knows.
 */
export function validateLogin(raw, what = 'author') {
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: `${what} must be a GitHub username, or "@me"` };
  const v = raw.trim();
  if (!v) return { ok: true, value: null };
  if (v === '@me') return { ok: true, value: v };
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(v)) {
    return { ok: false, error: `"${v}" is not a GitHub username. Give a login like "octocat", or "@me" for the account gh is signed in as.` };
  }
  return { ok: true, value: v };
}

/** One label. Repeatable — gh's `--label` is a `strings` flag. */
export function validateLabel(raw) {
  if (typeof raw !== 'string') return { ok: false, error: 'each label must be a string' };
  const v = raw.trim();
  if (!v) return { ok: false, error: 'a label may not be empty' };
  if (v.length > 60) return { ok: false, error: `the label is ${v.length} characters, over the 60 limit` };
  if (v.startsWith('-')) return { ok: false, error: `a label may not start with "-" — it would be read as a flag. If the label really is "${v}", filter with search instead.` };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(v)) return { ok: false, error: 'the label contains control characters' };
  return { ok: true, value: v };
}

/**
 * A GitHub search query — free text, on purpose.
 *
 * ⚠️ THIS IS THE ONE PARAMETER THAT MUST ALLOW SPACES, COLONS AND QUOTES, since
 * `is:open label:"needs triage" sort:updated` is what a search query looks like.
 * That is safe for exactly one reason and it is worth stating: it becomes ONE
 * ARGV ELEMENT, and an element is one argument no matter what is in it, because
 * `spawnBounded` sets `shell: false` and no shell exists to re-split it. The
 * character whitelist that `command.mjs` needs is a defence against a SHELL; it
 * is not needed, and would be actively wrong, here.
 */
export function validateSearch(raw) {
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: 'search must be a string' };
  const v = raw.trim();
  if (!v) return { ok: true, value: null };
  if (v.length > MAX_GH_SEARCH_CHARS) {
    return { ok: false, error: `the search query is ${v.length} characters, over the ${MAX_GH_SEARCH_CHARS} limit — narrow it with a qualifier like "label:bug" instead of prose` };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(v)) return { ok: false, error: 'the search query contains control characters' };
  return { ok: true, value: v };
}

export function validateEnum(raw, allowed, what) {
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: `${what} must be one of: ${allowed.join(', ')}` };
  const v = raw.trim().toLowerCase();
  if (!v) return { ok: true, value: null };
  if (!allowed.includes(v)) {
    return { ok: false, error: `"${raw}" is not a valid ${what}. Use one of: ${allowed.join(', ')}.` };
  }
  return { ok: true, value: v };
}

/**
 * ⭐ REUSED, NOT REWRITTEN. `git.mjs:validateBranchName` is already git's
 * `check-ref-format --branch` as a pure function, and a branch is a branch
 * whether git or gh is about to be handed it. A second copy is how the two
 * drift and one of them starts accepting `--force` as a branch name.
 */
export function validateBranchArg(raw, what) {
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: null };
  const r = validateBranchName(raw);
  if (!r.ok) return { ok: false, error: `${what}: ${r.error}` };
  return { ok: true, value: r.name };
}

/** A workflow file name or display name, e.g. "ci.yml". */
export function validateWorkflow(raw) {
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: 'workflow must be a string like "ci.yml"' };
  const v = raw.trim();
  if (!v) return { ok: true, value: null };
  if (v.length > 120) return { ok: false, error: `the workflow name is ${v.length} characters, over the 120 limit` };
  if (v.startsWith('-')) return { ok: false, error: 'a workflow name may not start with "-" — it would be read as a flag' };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(v)) return { ok: false, error: 'the workflow name contains control characters' };
  return { ok: true, value: v };
}

// ───────────────────────────────────────────────────────────────────────────
// THE VERB TABLE — the argv words live HERE and nowhere else
// ───────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ `--flag=value` RATHER THAN `--flag`, `value`, AND IT IS NOT STYLE.
 *
 * gh is a Go program using pflag, and pflag consumes the NEXT ARGUMENT as the
 * value of a flag that takes one — including an argument that begins with a
 * dash. So `['--label', '--json']` would set the label to the string
 * `--json`… or, depending on the flag's type, be re-read as a flag. The `=`
 * form has exactly one parse: everything after the first `=` is the value, and
 * it cannot be re-read as anything.
 *
 * ⭐ The validators refuse a leading `-` as well. Two independent mechanisms for
 * the same hole is deliberate here, because this is the boundary where a
 * model-authored string meets an argument parser we do not own.
 */
const flag = (name, value) => `--${name}=${value}`;

/**
 * ⚠️ EVERY ENTRY IS A `build` FUNCTION AND A CAP. The subcommand words —
 * 'issue', 'list', 'pr', 'view', 'run' — are string literals inside these
 * builders. Nothing the model sends is ever concatenated into a subcommand
 * position, which is what makes `pr merge` unreachable rather than refused.
 */
const VERBS = Object.freeze({
  'issue.list': {
    json: true,
    maxChars: MAX_GH_OUTPUT_CHARS,
    build(p) {
      const args = ['issue', 'list', flag('json', ISSUE_LIST_FIELDS)];
      const state = validateEnum(p.state, ['open', 'closed', 'all'], 'issue state');
      if (!state.ok) return state;
      if (state.value) args.push(flag('state', state.value));
      const limit = validateLimit(p.limit);
      if (!limit.ok) return limit;
      args.push(flag('limit', String(limit.value)));
      const labels = collectLabels(p.labels);
      if (!labels.ok) return labels;
      for (const l of labels.value) args.push(flag('label', l));
      const assignee = validateLogin(p.assignee, 'assignee');
      if (!assignee.ok) return assignee;
      if (assignee.value) args.push(flag('assignee', assignee.value));
      const author = validateLogin(p.author, 'author');
      if (!author.ok) return author;
      if (author.value) args.push(flag('author', author.value));
      const search = validateSearch(p.search);
      if (!search.ok) return search;
      if (search.value) args.push(flag('search', search.value));
      return { ok: true, args };
    },
  },
  'issue.view': {
    json: true,
    maxChars: MAX_GH_OUTPUT_CHARS,
    build(p) {
      const n = validateNumber(p.number, 'number');
      if (!n.ok) return n;
      return { ok: true, args: ['issue', 'view', String(n.value), flag('json', ISSUE_VIEW_FIELDS)] };
    },
  },
  /**
   * ── ⚠️ WHY `--body=` AND NOT `'--body', value` ──────────────────────────────
   *
   * `flag()` produces ONE argv element, `--body=<whatever>`, and `gh` reads
   * everything after the first `=` as the value. So a body of `--force` stays a
   * body. Pushed as two elements it would be indistinguishable from a real flag
   * the moment a model wrote one, and the model writes the body. Do not "tidy"
   * this into two pushes; `gh-write.test.mjs` fails if anyone does.
   */
  'issue.comment': {
    json: false,
    maxChars: MAX_GH_OUTPUT_CHARS,
    build(p) {
      const n = validateNumber(p.number, 'number');
      if (!n.ok) return n;
      const body = validateBody(p.body);
      if (!body.ok) return body;
      return { ok: true, args: ['issue', 'comment', String(n.value), flag('body', body.value)] };
    },
  },
  'pr.comment': {
    json: false,
    maxChars: MAX_GH_OUTPUT_CHARS,
    build(p) {
      const n = validateNumber(p.number, 'number');
      if (!n.ok) return n;
      const body = validateBody(p.body);
      if (!body.ok) return body;
      return { ok: true, args: ['pr', 'comment', String(n.value), flag('body', body.value)] };
    },
  },
  /**
   * ⭐ NO `--head`. `gh` infers the head branch from the checkout, and letting a
   * model name it would let it open a pull request from a branch it never
   * touched. `--base` is optional and validated; omitted, GitHub uses the
   * repository's default, which is the correct answer almost every time.
   */
  'pr.create': {
    json: false,
    maxChars: MAX_GH_OUTPUT_CHARS,
    build(p) {
      const title = validateTitle(p.title);
      if (!title.ok) return title;
      const body = validateBody(p.body);
      if (!body.ok) return body;
      const args = ['pr', 'create', flag('title', title.value), flag('body', body.value)];
      const base = validateBranchArg(p.base, 'base');
      if (!base.ok) return base;
      if (base.value) args.push(flag('base', base.value));
      /**
       * ⚠️ DRAFT IS AVAILABLE AND NOT THE DEFAULT. A draft PR is the polite
       * option, but making it the default would mean an agent that "opened a
       * PR" produced something nobody is asked to review — finishing the task in
       * form and not in fact.
       */
      if (p.draft === true) args.push('--draft');
      return { ok: true, args };
    },
  },
  'issue.comments': {
    json: true,
    maxChars: MAX_GH_OUTPUT_CHARS,
    build(p) {
      const n = validateNumber(p.number, 'number');
      if (!n.ok) return n;
      return { ok: true, args: ['issue', 'view', String(n.value), flag('json', ISSUE_COMMENTS_FIELDS)] };
    },
  },
  'pr.list': {
    json: true,
    maxChars: MAX_GH_OUTPUT_CHARS,
    build(p) {
      const args = ['pr', 'list', flag('json', PR_LIST_FIELDS)];
      const state = validateEnum(p.state, ['open', 'closed', 'merged', 'all'], 'pull request state');
      if (!state.ok) return state;
      if (state.value) args.push(flag('state', state.value));
      const limit = validateLimit(p.limit);
      if (!limit.ok) return limit;
      args.push(flag('limit', String(limit.value)));
      const head = validateBranchArg(p.head, 'head');
      if (!head.ok) return head;
      if (head.value) args.push(flag('head', head.value));
      const base = validateBranchArg(p.base, 'base');
      if (!base.ok) return base;
      if (base.value) args.push(flag('base', base.value));
      const author = validateLogin(p.author, 'author');
      if (!author.ok) return author;
      if (author.value) args.push(flag('author', author.value));
      const labels = collectLabels(p.labels);
      if (!labels.ok) return labels;
      for (const l of labels.value) args.push(flag('label', l));
      const search = validateSearch(p.search);
      if (!search.ok) return search;
      if (search.value) args.push(flag('search', search.value));
      return { ok: true, args };
    },
  },
  'pr.view': {
    json: true,
    maxChars: MAX_GH_OUTPUT_CHARS,
    build(p) {
      const n = validateNumber(p.number, 'number');
      if (!n.ok) return n;
      return { ok: true, args: ['pr', 'view', String(n.value), flag('json', PR_VIEW_FIELDS)] };
    },
  },
  'pr.comments': {
    json: true,
    maxChars: MAX_GH_OUTPUT_CHARS,
    build(p) {
      const n = validateNumber(p.number, 'number');
      if (!n.ok) return n;
      return { ok: true, args: ['pr', 'view', String(n.value), flag('json', PR_COMMENTS_FIELDS)] };
    },
  },
  'pr.diff': {
    json: false,
    maxChars: MAX_GH_DIFF_CHARS,
    build(p) {
      const n = validateNumber(p.number, 'number');
      if (!n.ok) return n;
      /**
       * ⚠️ `--color=never` EXPLICITLY, not by trusting `NO_COLOR`. gh's own flag
       * defaults to `auto`, and "auto" has been known to mean "yes" under a CI
       * harness that fakes a TTY. ANSI escapes inside a diff are tokens the
       * model pays for and cannot use, and they break any attempt to apply it.
       */
      return { ok: true, args: ['pr', 'diff', String(n.value), flag('color', 'never')] };
    },
  },
  'pr.checks': {
    json: true,
    maxChars: MAX_GH_OUTPUT_CHARS,
    /**
     * ⚠️⚠️ THIS VERB EXITS NON-ZERO WHEN IT WORKS. `gh pr checks` returns 8 for
     * pending checks and non-zero when a check has failed — i.e. the exact case
     * the model asked about. Treating that as a failure would mean "why is CI
     * red" reports "the tool broke", which is the single most misleading thing
     * this file could do. See `nonZeroIsAResult`.
     */
    nonZeroIsAResult: true,
    build(p) {
      const n = validateNumber(p.number, 'number');
      if (!n.ok) return n;
      return { ok: true, args: ['pr', 'checks', String(n.value), flag('json', PR_CHECKS_FIELDS)] };
    },
  },
  'run.list': {
    json: true,
    maxChars: MAX_GH_OUTPUT_CHARS,
    build(p) {
      const args = ['run', 'list', flag('json', RUN_LIST_FIELDS)];
      const limit = validateLimit(p.limit);
      if (!limit.ok) return limit;
      args.push(flag('limit', String(limit.value)));
      const branch = validateBranchArg(p.branch, 'branch');
      if (!branch.ok) return branch;
      if (branch.value) args.push(flag('branch', branch.value));
      const workflow = validateWorkflow(p.workflow);
      if (!workflow.ok) return workflow;
      if (workflow.value) args.push(flag('workflow', workflow.value));
      const status = validateEnum(p.status, RUN_STATUSES, 'run status');
      if (!status.ok) return status;
      if (status.value) args.push(flag('status', status.value));
      return { ok: true, args };
    },
  },
  'run.view': {
    json: true,
    maxChars: MAX_GH_OUTPUT_CHARS,
    build(p) {
      const n = validateNumber(p.runId, 'runId', MAX_RUN_ID);
      if (!n.ok) return n;
      return { ok: true, args: ['run', 'view', String(n.value), flag('json', RUN_VIEW_FIELDS)] };
    },
  },
  'run.failed': {
    /**
     * ⚠️ NO `--json` HERE, AND THAT IS gh's RULE NOT A CHOICE. `--log-failed`
     * and `--json` are mutually exclusive — asking for both is an error, so the
     * schema must never let the model believe it can have structure here.
     * Measured: `gh run view 1 --log-failed --json status` fails outright.
     */
    json: false,
    maxChars: MAX_GH_LOG_CHARS,
    /** An entirely green run prints nothing and exits 0. That is an ANSWER. */
    emptyIsAResult: 'no failed steps in this run — nothing was logged because nothing failed',
    build(p) {
      const n = validateNumber(p.runId, 'runId', MAX_RUN_ID);
      if (!n.ok) return n;
      const args = ['run', 'view', String(n.value), '--log-failed'];
      if (p.job !== null && p.job !== undefined && p.job !== '') {
        const j = validateNumber(p.job, 'job', MAX_RUN_ID);
        if (!j.ok) return j;
        args.push(flag('job', String(j.value)));
      }
      return { ok: true, args };
    },
  },
});

function collectLabels(raw) {
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: [] };
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length > MAX_GH_LABELS) {
    return { ok: false, error: `${list.length} labels is over the ${MAX_GH_LABELS} limit — filter on fewer, or use search with a query like "label:a label:b"` };
  }
  const out = [];
  for (const l of list) {
    const v = validateLabel(l);
    if (!v.ok) return v;
    out.push(v.value);
  }
  return { ok: true, value: out };
}

/** Which actions exist under each noun. ⭐ Derived from VERBS so it cannot drift. */
export const GH_NOUNS = Object.freeze({
  issue: ['list', 'view', 'comments'],
  pr: ['list', 'view', 'diff', 'checks', 'comments'],
  run: ['list', 'view', 'failed'],
});

/**
 * ── ⭐⭐⭐ THE LAST INCH OF EVERY TASK ────────────────────────────────────────
 *
 * Measured 2026-08-20: `gh` was read-only in every noun, so a run that read a PR
 * review, fixed the code and committed it **ended at a local branch**. Nobody
 * else could see the work. That is this CLI's biggest "cannot finish the job" —
 * bigger than any missing tool, because it is the last inch of every task.
 *
 * ⚠️ THE OLD REFUSAL WAS RIGHT ABOUT THE RISK, and its wording is the reason
 * this list is three items and not a noun: *"a comment, a close, a merge or a
 * re-run is visible to everyone watching the repository and cannot be undone by
 * trying again."* All true. So:
 *
 *   · `pr create` and `*.comment` ADD something, attributed, on work the agent
 *     just did. A bad one is embarrassing and editable by a human in ten seconds.
 *   · `merge`, `approve`, `close`, `delete`, `rerun` CHANGE OR END something
 *     other people are relying on. They stay refused, with the same message.
 *
 * ⚠️ AND IT IS OFF BY DEFAULT. Absent means off, exactly like `ACUVO_ALLOW_PUSH`
 * — a write to a shared repository must be asked for, never inherited from a
 * default nobody chose.
 */
export const GH_WRITE_ENV = 'ACUVO_GH_WRITE';

export function ghWriteEnabled(env = process.env) {
  const raw = String(env?.[GH_WRITE_ENV] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/**
 * ⚠️ `run` DELIBERATELY GAINS NOTHING. Re-running someone else's CI spends their
 * minutes and republishes a status other people are reading; there is no
 * additive write on that noun.
 */
const GH_WRITE_ACTIONS = Object.freeze({
  issue: ['comment'],
  pr: ['create', 'comment'],
  run: [],
});

/** The actions available RIGHT NOW, which depends on the operator's switch. */
export function ghNouns(env = process.env) {
  if (!ghWriteEnabled(env)) return GH_NOUNS;
  return Object.freeze({
    issue: [...GH_NOUNS.issue, ...GH_WRITE_ACTIONS.issue],
    pr: [...GH_NOUNS.pr, ...GH_WRITE_ACTIONS.pr],
    run: [...GH_NOUNS.run],
  });
}

/**
 * ⚠️ GitHub's own hard limit is 65,536 characters. This sits under it so the
 * refusal comes from us, with a sentence the model can act on, rather than from
 * the API as a 422 after the command has already run.
 *
 * ⭐ AND REFUSED, NEVER TRUNCATED. A tool result can be trimmed after the fact;
 * a comment cannot. Everyone watching the repository is emailed the version that
 * was posted, so half a diff is worse than an error the model can fix.
 */
export const MAX_GH_BODY_CHARS = 60_000;
export const MAX_GH_TITLE_CHARS = 256;

export function validateBody(raw, what = 'body') {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, error: `gh needs a non-empty ${what}.` };
  }
  if (raw.length > MAX_GH_BODY_CHARS) {
    return { ok: false, error: `that ${what} is ${raw.length} characters and the limit is ${MAX_GH_BODY_CHARS}. Post the summary and link to the detail — a comment nobody can read is worse than a short one.` };
  }
  return { ok: true, value: raw };
}

export function validateTitle(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    /**
     * ⚠️⚠️ NOT TIDINESS — A HANG. `gh pr create` with no title opens an editor,
     * and this CLI runs with no TTY, so the prompt is not a question: it is a
     * process that never returns and a timeout the model reads as a broken tool.
     */
    return { ok: false, error: 'gh pr create needs a title. Without one it opens an editor and hangs, because there is no terminal attached.' };
  }
  if (raw.length > MAX_GH_TITLE_CHARS) {
    return { ok: false, error: `that title is ${raw.length} characters and the limit is ${MAX_GH_TITLE_CHARS}.` };
  }
  return { ok: true, value: raw.trim() };
}

/**
 * ⚠️ THE NAMES A MODEL WILL REACH FOR, AND WHY EACH ONE IS A DEAD END.
 *
 * A refusal that only says "unknown action" is an obstacle: the model tries a
 * synonym, then another, and burns three paid rounds discovering a policy. Every
 * one of these is a write, and naming them individually lets the refusal say WHY
 * and hand the work back to the human in the same sentence.
 */
const KNOWN_WRITE_ACTIONS = Object.freeze({
  create: 'gh issue create / gh pr create',
  close: 'gh issue close',
  reopen: 'gh issue reopen',
  comment: 'gh issue comment / gh pr comment',
  edit: 'gh issue edit / gh pr edit',
  delete: 'gh issue delete',
  transfer: 'gh issue transfer',
  pin: 'gh issue pin',
  lock: 'gh issue lock',
  unlock: 'gh issue unlock',
  merge: 'gh pr merge',
  ready: 'gh pr ready',
  review: 'gh pr review',
  approve: 'gh pr review --approve',
  close_pr: 'gh pr close',
  checkout: 'gh pr checkout',
  rerun: 'gh run rerun',
  cancel: 'gh run cancel',
  download: 'gh run download',
  watch: 'gh run watch',
  api: 'gh api',
  release: 'gh release create',
  secret: 'gh secret set',
});

/**
 * Turn a noun + a parameter bag into an exact argv. PURE — no spawn, no
 * network, no filesystem, no environment except `--repo`, which is a parameter.
 *
 * @param {string} noun 'issue' | 'pr' | 'run'
 * @param {object} params
 * @returns {GhPlan | GhRefused}
 */
export function planGh(noun, params = {}, env = process.env) {
  /**
   * ⭐ THE AVAILABLE ACTIONS ARE READ ONCE, HERE, and every message below uses
   * the same object. A refusal that lists a different set from the one the
   * schema advertised is how a model learns to distrust its own tools.
   */
  const NOUNS = ghNouns(env);
  const n = typeof noun === 'string' ? noun.trim().toLowerCase() : '';
  if (!Object.prototype.hasOwnProperty.call(NOUNS, n)) {
    return { ok: false, error: `"${noun}" is not a GitHub noun this agent uses. Use one of: ${Object.keys(NOUNS).join(', ')}.` };
  }
  const p = params && typeof params === 'object' ? params : {};
  const rawAction = typeof p.action === 'string' ? p.action.trim().toLowerCase() : '';
  if (!rawAction) {
    return { ok: false, error: `gh_${n} needs an action. Available: ${NOUNS[n].join(', ')}.` };
  }
  if (!NOUNS[n].includes(rawAction)) {
    const write = KNOWN_WRITE_ACTIONS[rawAction];
    if (write) {
      /**
       * ⚠️ THE REASON DEPENDS ON WHICH WRITE IT IS, and saying the wrong one
       * teaches the model something false. With the switch OFF, `comment` is
       * refused because writes are disabled — telling it "this agent never
       * writes" would be a lie it could not correct by asking an operator. With
       * the switch ON, `merge` is refused because merging is not additive.
       */
      const disabled = !ghWriteEnabled(env);
      return {
        ok: false,
        error:
          `gh_${n} has no "${rawAction}" action here. `
          + (disabled
            ? `Writing to GitHub is switched off in this workspace (${GH_WRITE_ENV} is not set). `
            : 'That action changes or ends something other people are relying on, so it is not available to the agent: only additive writes are. ')
          + 'A close, a merge or a re-run is visible to everyone watching the repository and cannot be undone by trying again. '
          + `Run it yourself when you are ready: \`${write}\`. `
          + `What you can do here: ${NOUNS[n].join(', ')}.`,
      };
    }
    return { ok: false, error: `gh_${n} has no "${rawAction}" action. Available: ${NOUNS[n].join(', ')}.` };
  }

  const key = `${n}.${rawAction}`;
  const spec = VERBS[key];
  /* c8 ignore next */
  if (!spec) return { ok: false, error: `gh_${n} "${rawAction}" is not wired up` };

  const built = spec.build(p);
  if (!built.ok) return built;

  const repo = validateRepo(p.repo);
  if (!repo.ok) return repo;
  const args = repo.repo ? [...built.args, flag('repo', repo.repo)] : built.args;

  return {
    ok: true,
    verb: key,
    args,
    json: spec.json,
    maxChars: spec.maxChars,
    nonZeroIsAResult: spec.nonZeroIsAResult === true,
    emptyIsAResult: spec.emptyIsAResult ?? null,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// FINDING gh, AND THE TWO DIFFERENT WAYS IT IS UNAVAILABLE
// ───────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ AN ABSOLUTE PATH, FOR THE REASON `github.mjs:findToken` DOCUMENTS AT
 * LENGTH: on Windows a `gh.exe` sitting in the current directory beats
 * `C:\Program Files\GitHub CLI\gh.exe`, because libuv's own path search consults
 * cwd before PATH — and `shell: false` does NOT close that. `cd` into a cloned
 * repository and the attacker's binary is what runs. `resolveOnPath` walks PATH
 * with PATHEXT and never looks at cwd, which is the only thing that fixes it.
 */
export function resolveGh(env = process.env, { resolveImpl = resolveOnPath } = {}) {
  const found = resolveImpl('gh', env);
  if (!found) {
    return {
      ok: false,
      reason: 'not-installed',
      error: [
        'The GitHub CLI (gh) is not installed, or is not on PATH for this process, so nothing was read.',
        'Install it — `winget install GitHub.cli` on Windows, `brew install gh` on macOS,',
        'https://cli.github.com otherwise — then run `gh auth login` once.',
        'Until then the repository is still readable with git_log and git_diff, and `acuvo --issue N`',
        'still works if GITHUB_TOKEN is set, because that path uses the REST API rather than gh.',
      ].join(' '),
    };
  }
  if (found.ok !== true) {
    /**
     * ── ⚠️ AN HONEST LIMIT, STATED RATHER THAN WORKED AROUND ─────────────────
     *
     * `resolveOnPath` reports a `.cmd`/`.bat` shim separately (scoop and npm
     * installs produce one). `spawnBounded` hard-codes `shell: false` and the
     * whole package depends on that — a batch shim can only be run by handing
     * the argv to `cmd.exe`, which re-parses it, which is precisely the thing
     * every argument guard in this file exists to prevent.
     *
     * ⭐ So this refuses rather than quietly opening a shell, and names two ways
     * out that both work. Measured on the author's machine, `gh` resolves to
     * `C:\Program Files\GitHub CLI\gh.EXE` — a real executable — so this branch
     * is the minority case, not the normal one.
     */
    return {
      ok: false,
      reason: 'shim',
      error:
        `gh on this machine is a script shim (${found.shim}), and running one needs a shell, which this agent never opens — `
        + 'a shell would re-parse the arguments that every guard here exists to control. '
        + 'Point PATH at the real executable (the winget/MSI install puts gh.exe in "C:\\Program Files\\GitHub CLI"), '
        + 'or set GITHUB_TOKEN and use `acuvo --issue N`, which talks to the REST API and needs no gh at all.',
    };
  }
  return { ok: true, file: found.file };
}

/**
 * ── ⚠️⚠️ WHAT ENVIRONMENT A gh CHILD GETS, AND WHY IT IS NOT THE PUSH ONE ────
 *
 * `git.mjs:pushEnvironment` restores `SSH_AUTH_SOCK` because `scrubEnvironment`
 * deletes it (the SECRET_NAME regex at `command.mjs:1342` matches "AUTH") and
 * git genuinely cannot authenticate without the agent socket. gh needs no
 * socket: it speaks HTTPS to api.github.com with a token it stores itself.
 * Measured here — `gh auth status` reports `Logged in to github.com account
 * xxiautomate-star (keyring)` — so on this machine gh authenticates from the OS
 * keyring and a fully scrubbed environment costs nothing at all.
 *
 * ⚠️ BUT NOT EVERYWHERE, AND THIS IS THE REGRESSION A NAIVE SCRUB WOULD SHIP.
 * `GH_TOKEN` and `GITHUB_TOKEN` both match SECRET_NAME, so a plain
 * `scrubEnvironment` leaves gh with NO credential in exactly the environment
 * that only ever has one: CI. GitHub Actions injects `GITHUB_TOKEN` and nothing
 * else. Every verb here would fail with "not authenticated", on the one machine
 * where the user did everything right.
 *
 * ⭐ SO: a keep-list of exactly four names, and the argument for it is
 * DIRECTIONALITY. `github.mjs:findToken` already reads `GITHUB_TOKEN`/`GH_TOKEN`
 * and puts them in an `Authorization:` header to api.github.com — so these
 * tokens already, by design, travel to GitHub. Handing the same token to a gh
 * child sends it to the same destination, and the child is an absolute path off
 * PATH running an argv this file built.
 *
 * ⚠️ AND NOTHING ELSE COMES BACK. `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`,
 * `AWS_SECRET_ACCESS_KEY`, `DATABASE_URL` — the scrub deletes them and this
 * function does not restore them. That is the whole "do not let a token leak
 * into an unrelated child" rule: the GitHub token reaches the GitHub child, and
 * a model-provider key reaches neither.
 *
 * ── ⚠️⚠️ THE PARAGRAPH THAT USED TO BE HERE WAS THE VULNERABILITY ───────────
 *
 * It read: *"`GH_HOST` and `GH_CONFIG_DIR` are deliberately NOT in the
 * keep-list. They contain no SECRET_NAME word, so the scrub never removed them;
 * listing them would be a line no test could hold to account."*
 *
 * ⭐ EVERY CLAUSE OF THAT IS TRUE, AND THE CONCLUSION IS BACKWARDS. "The scrub
 * never removed them" is not a reason to leave them alone — it is the finding.
 * Not being in the keep-list meant they were never RE-ADDED; it never meant
 * they were absent. **`GH_HOST` passes straight through from the parent
 * environment**, and this file then hands the child `GH_ENTERPRISE_TOKEN` on
 * purpose.
 *
 * ⚠️⚠️ SO THE DIRECTIONALITY ARGUMENT ABOVE IS FALSE, and it is false in the
 * one way that matters: *"these tokens already, by design, travel to GitHub"*
 * holds only while something guarantees which host GitHub IS. `GH_HOST` is that
 * something, and until now anything that could set an environment variable
 * chose it. A cloned repository with `GH_HOST=attacker.example` in its `.env`
 * gets our enterprise token posted to `attacker.example`. The guard was
 * reasoning about the token and never about the destination.
 *
 * ⭐ THE FIX IS A DROP-LIST, NOT A LONGER KEEP-LIST. Both are deleted from the
 * child environment unconditionally, so the parent's value cannot reach gh at
 * all — the same shape as the workspace-env rule: a layer below the operator
 * may only ever REMOVE permission, never add it.
 *
 * ⚠️ AND THE ENTERPRISE TOKENS GO WITH THEM BY DEFAULT. An enterprise token is
 * only meaningful against an enterprise host; with `GH_HOST` gone it is a
 * credential with no destination, and shipping it to github.com is worse than
 * useless. GitHub Enterprise stays reachable through the explicit operator
 * opt-in below.
 */
export const GH_ENV_KEEP = Object.freeze(['GH_TOKEN', 'GITHUB_TOKEN']);

/**
 * ⚠️ REMOVED FROM THE CHILD NO MATTER WHAT THE PARENT SAYS. `GH_CONFIG_DIR` is
 * here for the same reason as `GH_HOST`: it points gh at a config file that can
 * itself name a host and carry credentials, so passing it through re-opens the
 * hole by another door.
 */
export const GH_ENV_DROP = Object.freeze([
  'GH_HOST', 'GH_CONFIG_DIR', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN',
]);

/**
 * ⭐ THE OPERATOR'S OWN OPT-IN, and the only way a non-github.com host is ever
 * reached. A GitHub Enterprise user sets `ACUVO_GH_HOST=github.mycorp.com` in
 * their real environment; a repository cannot, because `env-file.mjs` refuses
 * to let a workspace `.env` introduce an `ACUVO_*` variable at all.
 *
 * ⭐ THE INDIRECTION IS THE ENTIRE SECURITY PROPERTY: the name gh reads
 * (`GH_HOST`) is one a repo can set and is therefore always dropped; the name
 * WE read is one a repo cannot set. Same capability, different trust root.
 */
export const GH_HOST_OPT_IN = 'ACUVO_GH_HOST';

export function ghEnvironment(env = process.env) {
  const out = scrubEnvironment(env);
  for (const name of GH_ENV_KEEP) {
    const value = env?.[name];
    if (typeof value === 'string' && value !== '') out[name] = value;
  }
  /**
   * ⚠️ DELETED AFTER the keep-loop and after the scrub, so no earlier branch can
   * reintroduce them. Order matters here: this must be the last word on these
   * four names.
   */
  for (const name of GH_ENV_DROP) delete out[name];

  /**
   * The enterprise path, re-opened only by a variable the workspace cannot set.
   * ⚠️ The enterprise TOKEN comes back only alongside an explicit host — a
   * credential without a destination is never worth forwarding.
   */
  const optIn = String(env?.[GH_HOST_OPT_IN] ?? '').trim();
  if (optIn) {
    out.GH_HOST = optIn;
    for (const name of ['GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) {
      const value = env?.[name];
      if (typeof value === 'string' && value !== '') out[name] = value;
    }
  }
  /**
   * ⚠️ EVERY ONE OF THESE PREVENTS A HANG OR A WASTED TOKEN, and they are the
   * same three failures `gitEnvironment` closes for git:
   * · `GH_PAGER`/`PAGER=cat` — gh pipes long output through a pager that waits
   *   for a keypress that will never come. That is a tool call that burns the
   *   whole timeout and reports nothing.
   * · `GH_PROMPT_DISABLED` — gh asking "Which repository?" on a process with no
   *   terminal is the same hang with a different cause.
   * · `NO_COLOR` / `CLICOLOR=0` — ANSI escapes are tokens the model pays for and
   *   cannot use.
   * · `GH_NO_UPDATE_NOTIFIER` — the "a new release of gh is available" banner is
   *   noise that has broken more than one output parser.
   * ⚠️ `GH_FORCE_TTY` is DELETED rather than set: if an operator has it in their
   *   environment, gh formats for a terminal width and truncates titles, which
   *   silently corrupts the structured output we asked for.
   */
  out.GH_PAGER = 'cat';
  out.PAGER = 'cat';
  out.NO_COLOR = '1';
  out.CLICOLOR = '0';
  out.GH_PROMPT_DISABLED = '1';
  out.GH_NO_UPDATE_NOTIFIER = '1';
  delete out.GH_FORCE_TTY;
  return out;
}

/**
 * Translate a gh failure into one sentence a model can act on.
 *
 * ── ⚠️⚠️ THE ORDER IS LOAD-BEARING, AND I ONLY FOUND OUT BY RUNNING IT ──────
 *
 * Measured, gh 2.90.0, in a directory whose origin is not a GitHub remote:
 *
 *   failed to determine base repo: none of the git remotes configured for this
 *   repository point to a known GitHub host. To tell gh about a new GitHub
 *   host, please use `gh auth login`
 *
 * ⭐ gh's OWN error text tells you to run `gh auth login` for a problem that has
 * nothing to do with authentication. Any auth check written as "does the message
 * mention gh auth login" classifies this as "not signed in" — and the model then
 * spends its next round telling a signed-in user to sign in, while the actual
 * fix (`repo: "owner/name"`) goes unmentioned. This is `an error string is an
 * instruction` in its purest form, and the only defence is to test the specific
 * cause BEFORE the generic one.
 */
export function classifyGhFailure(text) {
  const s = String(text ?? '');
  if (/failed to determine base repo|none of the git remotes/i.test(s)) {
    return {
      reason: 'no-github-repo',
      error:
        'gh could not work out which GitHub repository this is: the workspace has no remote pointing at github.com. '
        + '(gh\'s own message suggests `gh auth login` here, which is a red herring — this is not an authentication problem.) '
        + 'Pass repo: "owner/name" to say which repository you mean, or run this from a clone that has a GitHub origin.',
    };
  }
  if (/gh auth login|not logged in|no such host|authentication token|requires authentication|HTTP 401|Bad credentials/i.test(s)) {
    return {
      reason: 'not-authenticated',
      error:
        'gh is installed but has no usable credential for github.com, so nothing was read. '
        + 'Run `gh auth login` once in your own terminal, or set GH_TOKEN in the environment — this agent will pick up either. '
        + 'It cannot sign in on your behalf: that is an interactive, account-level act.',
    };
  }
  if (/HTTP 404|Could not resolve to a|not found/i.test(s)) {
    return {
      reason: 'not-found',
      error:
        'GitHub returned "not found". On GitHub that is ambiguous on purpose: it means either no such issue, pull request or run — '
        + 'or that it exists in a private repository your token cannot see. Check the number, then check the token\'s scopes with `gh auth status`.',
    };
  }
  if (/HTTP 403|rate limit|API rate limit exceeded/i.test(s)) {
    return {
      reason: 'forbidden',
      error:
        'GitHub refused the request (403). Either the token lacks the scope for this — a workflow run needs the `workflow` scope, '
        + 'a private repository needs `repo` — or you are rate limited. `gh auth status` shows the scopes; a rate limit clears on its own.',
    };
  }
  return null;
}

// ───────────────────────────────────────────────────────────────────────────
// THE CAP — and saying so out loud
// ───────────────────────────────────────────────────────────────────────────

/**
 * ── ⭐ A CAPPED ANSWER MUST STILL BE A TRUE ANSWER ──────────────────────────
 *
 * Two different shapes need two different cuts, and conflating them is how a
 * model gets handed a lie:
 *
 * · AN ARRAY (a list of issues, PRs, runs, checks) is cut by DROPPING ITEMS. The
 *   text stays valid JSON, `capNote` says how many of how many are shown, and
 *   the way out is a real one — a narrower filter or a smaller limit.
 * · AN OBJECT (one PR with its reviews and its body) cannot be cut that way, so
 *   the SERIALISED TEXT is clamped head-and-tail by `clampOutput` and the result
 *   is deliberately no longer parseable. ⚠️ That is why `capNote` is not
 *   optional here: a model handed truncated JSON with no warning will read the
 *   surviving fields as the whole record.
 *
 * ⭐ `json` always carries the FULL parsed value regardless, so the caller that
 * wants to summarise rather than paste has something to summarise from.
 */
export function capJsonPayload(value, maxChars = MAX_GH_OUTPUT_CHARS) {
  const full = JSON.stringify(value, null, 2);
  if (full.length <= maxChars) {
    return { text: full, json: value, truncated: false, omitted: 0, capNote: null };
  }
  if (Array.isArray(value)) {
    const kept = [];
    let size = 2; // the brackets
    for (const item of value) {
      const piece = JSON.stringify(item, null, 2);
      if (size + piece.length + 2 > maxChars) break;
      size += piece.length + 2;
      kept.push(item);
    }
    /**
     * ⚠️ AT LEAST ONE ITEM, ALWAYS. A single review comment can be longer than
     * the whole budget, and returning `[]` would say "there are none" — a
     * confident falsehood about the exact thing that was asked for. One
     * over-budget item plus a note that says so is honest; zero items is not.
     */
    if (kept.length === 0 && value.length > 0) kept.push(value[0]);
    /**
     * ⚠️ RE-MEASURED AGAINST THE REAL STRING. The loop above sizes each item on
     * its own, but nesting it inside an array adds two spaces of indent to every
     * line — so a budget computed from the pieces is systematically UNDER the
     * size of the whole. A cap that is "roughly" a cap is a cap that occasionally
     * is not one, which is the class of bug this package treats as the worst it
     * can ship. Drop items until the actual text fits, never below one.
     */
    let text = JSON.stringify(kept, null, 2);
    while (text.length > maxChars && kept.length > 1) {
      kept.pop();
      text = JSON.stringify(kept, null, 2);
    }
    return {
      text,
      json: value,
      truncated: true,
      omitted: value.length - kept.length,
      capNote: `⚠️ Showing ${kept.length} of ${value.length} — the rest was cut to fit. Narrow it: a smaller limit, a state, a label, or a search query.`,
    };
  }
  const clamped = clampOutput(full, maxChars);
  return {
    text: clamped.text,
    json: value,
    truncated: true,
    omitted: clamped.omitted,
    capNote: `⚠️ ${clamped.omitted} characters were cut from the middle, so this JSON is TRUNCATED and no longer valid JSON — do not assume a field is absent because you cannot see it. Ask for one thing at a time (a single number rather than a list) if you need the whole record.`,
  };
}

/** The same honesty for plain text — a diff, a failed-step log. */
export function capTextPayload(text, maxChars, kind) {
  const clamped = clampOutput(String(text ?? ''), maxChars);
  if (!clamped.truncated) return { text: clamped.text, truncated: false, omitted: 0, capNote: null };
  const way = kind === 'diff'
    ? 'Use gh_pr { action: "view" } to list the changed files, then read_file the ones that matter — a whole diff never fits.'
    : 'Read the tail: it is kept above, and a failed step\'s error is almost always in the last lines. For more, open the run in the browser at the url from gh_run view.';
  return {
    text: clamped.text,
    truncated: true,
    omitted: clamped.omitted,
    capNote: `⚠️ ${clamped.omitted} characters were cut from the MIDDLE (the head and the tail are both kept). ${way}`,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// RUNNING IT
// ───────────────────────────────────────────────────────────────────────────

/**
 * Execute a plan. The only impure function in the file, and everything it
 * touches — the spawn, the environment, the gh lookup — is injectable, so every
 * branch below is reachable in a test with no network, no spawn and no gh.
 *
 * @param {string} root cwd for the child: gh resolves the repository from it.
 * @returns {Promise<GhRefused | object>}
 */
export async function runGh(root, plan, {
  env = process.env,
  spawnImpl,
  resolveImpl = resolveOnPath,
  timeoutMs = GH_TIMEOUT_MS,
} = {}) {
  if (!plan || plan.ok !== true) return plan ?? { ok: false, error: 'no plan to run' };

  const gh = resolveGh(env, { resolveImpl });
  if (!gh.ok) return { ok: false, error: gh.error, reason: gh.reason };

  const run = await spawnBounded({
    file: gh.file,
    args: plan.args,
    cwd: root,
    timeoutMs,
    spawnImpl,
    env: ghEnvironment(env),
  });
  if (!run.ok) return { ok: false, error: run.error };
  if (run.timedOut) {
    return { ok: false, reason: 'timeout', error: `gh did not finish within ${Math.round(timeoutMs / 1000)}s and was stopped. GitHub may be slow or unreachable; try again, or ask for less (a smaller limit, one item instead of a list).` };
  }

  const combined = `${run.stdout}\n${run.stderr}`;
  const failed = run.exitCode !== 0 && !(plan.nonZeroIsAResult && run.stdout.trim() !== '');
  if (failed) {
    const known = classifyGhFailure(combined);
    if (known) return { ok: false, reason: known.reason, error: known.error };
    const raw = combined.trim();
    return { ok: false, reason: 'gh-error', error: raw ? clampOutput(raw, 2_000).text : `gh exited ${run.exitCode} without saying why` };
  }

  /**
   * ⚠️⚠️ WHAT `spawnBounded` ALREADY THREW AWAY, BEFORE THIS FILE SAW ANYTHING.
   * It caps each stream at `MAX_CAPTURED_CHARS` and reports the true loss in
   * `stdoutOmitted` / `stdoutProduced`. Ignoring those (which the first draft
   * did) means every result computes its `truncated` flag against an
   * already-truncated string and answers "no". Read them once, here, and let
   * both branches below fold them in.
   */
  const lostUpstream = Number(run.stdoutOmitted ?? 0);

  if (plan.json) {
    const body = run.stdout.trim();
    /**
     * ── ⭐ A CLIPPED STREAM IS NOT "gh RETURNED SOMETHING ELSE" ──────────────
     *
     * This case used to fall through to the JSON.parse failure below, whose
     * message is "gh was asked for JSON and returned something else". That is
     * false and it is expensively false: gh returned perfectly good JSON, WE cut
     * the middle out of it, and the model would go on to doubt gh, re-run the
     * same call, and get the same answer. Diagnose it where it happened and name
     * the way out, which is genuinely "ask for less".
     */
    if (lostUpstream > 0) {
      /**
       * ⚠️⚠️ AND IT IS NOT A REFUSAL EITHER, WHICH IS THE SECOND HALF OF THE
       * LESSON. My first fix returned `ok: false` here with an honest
       * explanation and the advice "ask for less". Measured against cli/cli
       * #9000, that turned the two best verbs into a dead end: there is no unit
       * smaller than one issue, so the advice could not be followed.
       *
       * ⭐ `clampOutput` keeps the HEAD AND THE TAIL, so what survives is the
       * beginning of the record — number, title, state, the start of the body —
       * which is most of what the model needed. Handing that back with a loud,
       * unmissable warning beats handing back nothing. `json` is null rather
       * than a half-parsed object, because a partial object with missing fields
       * is precisely the lie this whole section exists to prevent.
       */
      const narrower = plan.verb.endsWith('.view')
        ? ` For the discussion instead of the body, use action "comments".`
        : ' Ask for less: a smaller limit, or a state/label filter.';
      return {
        ok: true,
        verb: plan.verb,
        exitCode: run.exitCode,
        json: null,
        text: run.stdout,
        truncated: true,
        omitted: lostUpstream,
        capNote:
          `⚠️ THIS IS NOT VALID JSON AND FIELDS ARE MISSING. gh returned ${run.stdoutProduced} characters; only ${MAX_CAPTURED_CHARS} can be captured, `
          + `so ${lostUpstream} were cut from the MIDDLE (the head and tail are kept). Do not conclude a field is empty or absent because you cannot see it.${narrower}`,
        checksFailing: false,
      };
    }
    if (!body) {
      return { ok: false, reason: 'empty', error: 'gh returned nothing where JSON was expected. That usually means the command was answered by a prompt this agent cannot see — check `gh auth status`.' };
    }
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      /**
       * ⚠️ THE RAW TEXT RIDES ALONG. A JSON parse failure here is nearly always
       * gh printing a banner or a warning onto stdout, and the ONLY way anyone
       * diagnoses that is by seeing what it actually printed.
       */
      return { ok: false, reason: 'bad-json', error: `gh was asked for JSON and returned something else:\n${clampOutput(body, 1_000).text}` };
    }
    const capped = capJsonPayload(parsed, plan.maxChars);
    return {
      ok: true,
      verb: plan.verb,
      exitCode: run.exitCode,
      json: capped.json,
      text: capped.text,
      truncated: capped.truncated,
      omitted: capped.omitted,
      capNote: capped.capNote,
      // ⭐ Said out loud rather than inferred from the exit code. `pr checks`
      // exits non-zero precisely when the answer is interesting.
      checksFailing: plan.nonZeroIsAResult && run.exitCode !== 0,
    };
  }

  const body = run.stdout.trim();
  if (!body && plan.emptyIsAResult) {
    // ⚠️ AN ANSWER, NOT AN ABSENCE — the `gitDiff` empty-diff argument. "No
    // failed steps" is the thing the model most wants to hear and would
    // otherwise have to infer from a blank string.
    return { ok: true, verb: plan.verb, exitCode: run.exitCode, text: '', empty: true, note: plan.emptyIsAResult, truncated: false, omitted: 0, capNote: null };
  }
  const capped = capTextPayload(run.stdout, plan.maxChars, plan.verb === 'pr.diff' ? 'diff' : 'log');
  /**
   * ⭐ THE TWO CUTS ARE ADDED TOGETHER AND REPORTED AS ONE NUMBER. A caller that
   * sees `truncated: true, omitted: 214_337` can reason about it; one that sees
   * `truncated: false` because our own cap happened not to fire cannot.
   */
  const truncated = capped.truncated || lostUpstream > 0;
  /**
   * ⚠️ ONE COHERENT NUMBER, AND THE FIRST VERSION OF THIS WAS NONSENSE.
   * Measured on a real `run --log-failed`: it printed "31 characters were cut
   * from the MIDDLE … (1039 of those characters were dropped while capturing)".
   * 1,039 of 31. Two independent cuts were being narrated as one, and a reader
   * checking the arithmetic would conclude the whole report was untrustworthy —
   * which, on a message whose entire job is to be believed about missing data,
   * is the worst possible failure. State the TOTAL, then break it down.
   */
  const totalOmitted = capped.omitted + lostUpstream;
  const way = capped.capNote?.replace(/^⚠️ \d+ characters[^.]*\.\s*/, '') ?? '';
  const note = lostUpstream > 0
    ? `⚠️ ${totalOmitted} characters were cut from the MIDDLE of this output (the head and the tail are kept): `
      + `${lostUpstream} because gh produced ${run.stdoutProduced} characters and only ${MAX_CAPTURED_CHARS} can be captured`
      + `${capped.omitted > 0 ? `, and ${capped.omitted} more to fit the tool result` : ''}. ${way}`
    : capped.capNote;
  return {
    ok: true,
    verb: plan.verb,
    exitCode: run.exitCode,
    text: capped.text,
    empty: body === '',
    truncated,
    omitted: capped.omitted + lostUpstream,
    capNote: truncated ? note : null,
  };
}

/** Plan then run — the single entry point the dispatcher calls. */
export async function executeGh(root, noun, params = {}, opts = {}) {
  const plan = planGh(noun, params);
  if (!plan.ok) return plan;
  return runGh(root, plan, opts);
}

// ───────────────────────────────────────────────────────────────────────────
// THE OFFER
// ───────────────────────────────────────────────────────────────────────────

/**
 * ⭐ THREE SCHEMAS, NOT NINE — grouped by NOUN with an enumerated action.
 *
 * git.mjs gives each verb its own schema because its verbs take genuinely
 * different parameters and one of them (push) has to be gated separately. These
 * nine share a parameter bag almost entirely, and nine schemas is roughly 900
 * tokens on EVERY round of every run. The enum is still a closed set: it is
 * rendered from `GH_NOUNS`, which is the same table `planGh` dispatches on, so
 * the offer and the dispatcher cannot drift apart.
 *
 * ⚠️ AND THE ENUM IS NOT THE SECURITY BOUNDARY. A provider that echoes a stale
 * tool list, or a resumed session, can put any string in `action` — which is why
 * `planGh` refuses an unknown action itself rather than trusting the schema.
 * `git.mjs:gitPush` makes the same argument about `pushEnabled` being checked at
 * the dispatcher as well as at the offer, and cites the test that proves it.
 *
 * ⭐ FOLLOWS `gitPushToolNames`: if gh is not installed these schemas are never
 * MENTIONED, so a machine without gh pays zero tokens for verbs it cannot run.
 */
export function ghToolNames(env = process.env, { resolveImpl = resolveOnPath } = {}) {
  return resolveGh(env, { resolveImpl }).ok ? ['gh_issue', 'gh_pr', 'gh_run'] : [];
}

const READ_ONLY_LINE = 'This agent only READS GitHub — there is no create, comment, close, merge, approve or re-run, by construction rather than by refusal.';

/**
 * ⚠️ THE SCHEMA MUST DESCRIBE THE TOOL THE MODEL ACTUALLY HAS. Advertising an
 * action that is switched off burns a paid round on a refusal; hiding one that
 * is switched on is capability nobody can reach — this package has shipped both,
 * most recently three tools declared, executable, advertised and never offered.
 * So the enum comes from `ghNouns(env)`, the same function `planGh` validates
 * against, and the two cannot disagree.
 */
export function ghToolSchemas(env = process.env) {
  const NOUNS = ghNouns(env);
  const writes = ghWriteEnabled(env);
  const policyLine = writes
    ? 'This agent can ADD to GitHub — open a pull request, comment on an issue or a PR — but never close, merge, approve, delete or re-run: those change or end something other people rely on.'
    : READ_ONLY_LINE;
  const writeProps = writes
    ? {
      title: { type: 'string', description: 'pr create only — the PR title. REQUIRED for create; without it gh opens an editor and hangs.' },
      body: { type: 'string', description: 'pr create / comment — the markdown body. REQUIRED. Say what changed and why, and reference the commit.' },
      draft: { type: 'boolean', description: 'pr create only — open it as a draft. Default false.' },
    }
    : {};
  return [
    {
      type: 'function',
      function: {
        name: 'gh_issue',
        description: [
          'Read GitHub issues: list them, read one\'s body with "view", or read its discussion with',
          '"comments". ⚠️ view and comments are SEPARATE calls on purpose — a real issue\'s body and',
          'its comment thread together exceed what one tool result can carry.',
          policyLine,
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: NOUNS.issue, description: '"list" for many, "view" for one issue\'s body, "comments" for its discussion. view and comments both need number.' },
            number: { type: 'number', description: 'Issue number. Required for view.' },
            state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Default open.' },
            limit: { type: 'number', description: `How many, 1–${MAX_GH_LIMIT} (default ${DEFAULT_GH_LIMIT}).` },
            labels: { type: 'array', items: { type: 'string' }, description: 'Only issues carrying all of these labels.' },
            assignee: { type: 'string', description: 'A GitHub login, or "@me".' },
            author: { type: 'string', description: 'A GitHub login, or "@me".' },
            search: { type: 'string', description: 'A GitHub search query, e.g. "sort:updated label:bug".' },
            repo: { type: 'string', description: 'Another repository as "owner/name". Omit for the one this workspace is in.' },
            ...(writes ? { body: writeProps.body } : {}),
          },
          required: ['action'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'gh_pr',
        description: [
          'Read GitHub pull requests. ⭐ "comments" is the one you want when asked to address review',
          'feedback: it returns the REVIEWS and the review COMMENTS. "view" is the body, the branches',
          'and the changed files; "diff" is the patch; "checks" is the fastest look at whether CI is',
          'green. ⚠️ view and comments are separate calls because together they do not fit.',
          policyLine,
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: NOUNS.pr, description: '"list", "view" (body + files), "comments" (reviews + review comments), "diff" (the patch), "checks" (CI status).' },
            number: { type: 'number', description: 'Pull request number. Required for view, comments, diff and checks.' },
            state: { type: 'string', enum: ['open', 'closed', 'merged', 'all'], description: 'Default open. list only.' },
            limit: { type: 'number', description: `How many, 1–${MAX_GH_LIMIT} (default ${DEFAULT_GH_LIMIT}).` },
            head: { type: 'string', description: 'list only — the branch the PR is FROM. Use it to find the PR for a branch.' },
            base: { type: 'string', description: 'list only — the branch the PR merges INTO.' },
            author: { type: 'string', description: 'A GitHub login, or "@me".' },
            labels: { type: 'array', items: { type: 'string' }, description: 'Only pull requests carrying all of these labels.' },
            search: { type: 'string', description: 'A GitHub search query.' },
            repo: { type: 'string', description: 'Another repository as "owner/name".' },
            ...writeProps,
          },
          required: ['action'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'gh_run',
        description: [
          'Read GitHub Actions runs: list recent runs, view one with its jobs, or — the useful one —',
          'action "failed" to read the log of ONLY the steps that failed. That is how you find out why',
          'CI went red without pulling megabytes of successful setup output.',
          policyLine,
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: NOUNS.run, description: '"list", "view" (run + jobs), "failed" (log of the failed steps only).' },
            runId: { type: 'number', description: 'The run id (databaseId from list). Required for view and failed.' },
            job: { type: 'number', description: 'failed only — narrow to one job id from view.' },
            limit: { type: 'number', description: `How many, 1–${MAX_GH_LIMIT} (default ${DEFAULT_GH_LIMIT}).` },
            branch: { type: 'string', description: 'list only — runs for this branch.' },
            workflow: { type: 'string', description: 'list only — e.g. "ci.yml".' },
            status: { type: 'string', enum: [...RUN_STATUSES], description: 'list only — e.g. "failure" for just the red ones.' },
            repo: { type: 'string', description: 'Another repository as "owner/name".' },
          },
          required: ['action'],
        },
      },
    },
  ];
}
