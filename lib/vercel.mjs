/**
 * ── ⭐⭐ `vercel_preview` — CODE → A URL SOMEBODY ELSE CAN OPEN ───────────────
 *
 * The third of the three integrations that close the developer loop. `gh.mjs`
 * reads the issue, `git.mjs` makes the branch and the commit, and until now the
 * loop ended at "it builds on my machine". A preview URL is the only artefact in
 * that chain a non-programmer can check, so it is the one that turns a run into
 * evidence.
 *
 * ── ⚠️⚠️ A DEPLOY IS THE ONLY VERB IN THIS PACKAGE THAT SPENDS MONEY ────────
 *
 * Everything else here costs tokens, which the budget ledger already governs. A
 * Vercel deployment is a BUILD on somebody's account: metered on Pro, capped at
 * 100/day on Hobby, and it happens on Vercel's side the instant the POST lands —
 * there is no refund, no undo, and `git reset` does not reach it.
 *
 * So this module is built around three rules, and all three are tested:
 *
 *   1. **IT IS NEVER IMPLICIT.** The verb is not even MENTIONED to the model
 *      unless the operator sets `ACUVO_ALLOW_DEPLOY=1`, exactly as `git_push`
 *      is gated by `ACUVO_ALLOW_PUSH` — and, like that one, the gate is checked
 *      again at the dispatcher, because a model can emit a call for a tool it
 *      was never shown (a resumed session, a provider echoing a stale tool
 *      list). A gate that lives only in the offer does not hold.
 *
 *   2. **IT SAYS WHAT IT WILL COST BEFORE IT SPENDS IT.** `action: "plan"` is
 *      free, touches no network at all, and returns the file count, the byte
 *      count and the sentence "this will consume 1 Vercel build". `action:
 *      "deploy"` refuses unless `acknowledgeBuildCost` is literally `true`. An
 *      agent that has not read the price cannot pay it.
 *
 *   3. **IT CANNOT DEPLOY TO PRODUCTION.** `target` is never sent. Vercel treats
 *      an absent `target` as a preview, and `createPreviewDeployment` has no
 *      parameter for it — so there is no argument, no default and no typo that
 *      reaches production. `executeVercel` additionally refuses a `target` key
 *      in the model's arguments rather than ignoring it, because silently
 *      dropping the word "production" from a request is how somebody comes to
 *      believe they shipped.
 *
 * ── ⭐ AND A FAILED DEPLOY WITHOUT ITS LOG IS USELESS ────────────────────────
 *
 * When the build goes red this fetches the build events and returns the tail
 * itself. "Deployment failed" is a status; `Module not found: './uilts'` is a
 * fix. The money is already spent by then — the only thing left to salvage is
 * the reason, and making the agent guess a second verb to find it wastes a
 * round it could have spent fixing the bug.
 *
 * ── ⚠️ ZERO DEPENDENCIES, SO NO `@vercel/sdk` AND NO `vercel` BINARY ────────
 *
 * The REST API over `fetch`, and `node:crypto` for the SHA-1 digests Vercel's
 * upload endpoint keys on. Spawning the `vercel` CLI was the other option and is
 * worse twice over: it is not installed on most machines, and `vercel deploy`
 * with no arguments is a PRODUCTION deploy on a linked project — the one
 * outcome rule 3 exists to make unreachable.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

import { refusedCommitPath } from './secret-paths.mjs';

const API = 'https://api.vercel.com';

/** The operator's switch. ⚠️ Absent means OFF — a deploy must be asked for. */
export const ALLOW_DEPLOY_ENV = 'ACUVO_ALLOW_DEPLOY';

/** Vercel is fast or broken; a long wait on the control plane is not useful. */
export const API_TIMEOUT_MS = 30_000;
/** An upload carries bytes, so it gets longer than a control-plane call. */
export const UPLOAD_TIMEOUT_MS = 120_000;
/** A cold Next.js build on Vercel routinely takes two to four minutes. */
export const POLL_TIMEOUT_MS = 900_000;
export const POLL_INTERVAL_MS = 4_000;

/**
 * ⚠️ THE CAPS ARE REFUSALS, NOT TRUNCATIONS. Silently uploading the first 3000
 * files of a 9000-file workspace produces a deployment that builds, deploys, and
 * is missing a module — a paid build spent proving nothing. Refuse and say which
 * directory is enormous, so the user fixes `.vercelignore` and pays once.
 */
export const MAX_FILES = 3_000;
export const MAX_TOTAL_BYTES = 40 * 1024 * 1024;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * ⚠️ DELIBERATELY NOT `repo-map.mjs`'s `SKIP_DIRS`, AND THE DIFFERENCE MATTERS.
 * That list skips `dist` and `build` because they are generated noise when you
 * are trying to understand a repository. Here they are frequently THE DEPLOYABLE
 * ARTEFACT — a static site is very often nothing but `dist/` — and skipping them
 * would upload an empty deployment. Same words, opposite job, so it is a second
 * list on purpose rather than a shared one nobody dares change.
 */
export const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', '.nuxt', '.svelte-kit', '.vercel',
  '.turbo', '.cache', 'coverage', '.acuvo', '.venv', '__pycache__', '.pytest_cache',
]);

// ───────────────────────────────────────────────────────────────────────────
// CREDENTIALS
// ───────────────────────────────────────────────────────────────────────────

/**
 * Find a token without demanding one be set.
 *
 * ⭐ FOLLOWS `github.mjs:findToken`'s argument: someone who has already logged
 * into the Vercel CLI has already done this configuration, and asking them to
 * do it a second time is how a feature goes unused. The difference is that we
 * READ THE CLI'S FILE rather than spawning the CLI — `gh auth token` needed a
 * process because the token is in a keyring; Vercel's sits in a JSON file, and
 * not spawning anything sidesteps the whole `gh.exe`-in-the-current-directory
 * hijack that `github.mjs` had to be fixed for.
 */
export function findToken({ env = process.env, readFileImpl = readFileSync, homeImpl = homedir } = {}) {
  const fromEnv = String(env?.VERCEL_TOKEN ?? '').trim() || String(env?.VERCEL_API_TOKEN ?? '').trim();
  if (fromEnv) return { ok: true, token: fromEnv, source: 'VERCEL_TOKEN' };

  let home = '';
  try { home = homeImpl(); } catch { home = ''; }
  if (home) {
    /** The three places the Vercel CLI keeps `auth.json`, per platform. */
    const candidates = [
      join(home, '.local', 'share', 'com.vercel.cli', 'auth.json'),
      join(home, 'Library', 'Application Support', 'com.vercel.cli', 'auth.json'),
      join(home, 'AppData', 'Roaming', 'com.vercel.cli', 'auth.json'),
    ];
    for (const file of candidates) {
      try {
        const parsed = JSON.parse(String(readFileImpl(file, 'utf8')));
        const t = String(parsed?.token ?? '').trim();
        if (t) return { ok: true, token: t, source: 'the Vercel CLI login' };
      } catch { /* not logged in on this platform — normal */ }
    }
  }
  return {
    ok: false,
    error: [
      'No Vercel credentials found.',
      '  Either:  vercel login            (Acuvo will reuse it)',
      '  Or:      export VERCEL_TOKEN=... (https://vercel.com/account/tokens)',
    ].join('\n'),
  };
}

/**
 * What `vercel link` already wrote down, if anything.
 *
 * ⭐ MEASURED, AND IT IS THE DIFFERENCE BETWEEN A USEFUL VERB AND A CONFUSING
 * ONE. Probed against the real API 2026-08-25: this token's deployments live
 * under the scope `xxiautomate-stars-projects`, not a bare personal account. A
 * deploy that ignored that would either 403 or silently create a SECOND project
 * named after the checkout folder — so the user asks for "a preview of my app"
 * and gets a brand-new empty project with none of their environment variables.
 * `.vercel/project.json` is the file the Vercel CLI writes for exactly this, so
 * reading it is assembly rather than guesswork.
 *
 * ⚠️ `.vercel` IS IN `SKIP_DIRS`, so this file is read and never uploaded.
 */
export function readLinkedProject(root, { readFileImpl = readFileSync } = {}) {
  try {
    const p = JSON.parse(String(readFileImpl(join(root, '.vercel', 'project.json'), 'utf8')));
    const projectId = String(p?.projectId ?? '').trim();
    if (!projectId) return null;
    return { projectId, orgId: String(p?.orgId ?? '').trim() || null };
  } catch { return null; }
}

/**
 * The team to act as, or null for the token's own scope.
 *
 * ⚠️ ONLY A `team_` PREFIX COUNTS. `.vercel/project.json` stores a personal
 * account's id in `orgId` too (measured: `HuEWmf1BucDyKkdJ7EtINcQm`), and
 * sending that as `teamId` is a 403 on every call — a deploy that fails for a
 * reason the user cannot see anywhere in their own configuration.
 */
export function teamIdFor(root, { env = process.env, ...io } = {}) {
  const fromEnv = String(env?.VERCEL_TEAM_ID ?? '').trim();
  if (fromEnv) return fromEnv;
  const linked = readLinkedProject(root, io);
  const orgId = linked?.orgId ?? '';
  return orgId.startsWith('team_') ? orgId : null;
}

/** `?teamId=…` or nothing, appended to a path that may already have a query. */
function scope(path, teamId) {
  if (!teamId) return path;
  return `${path}${path.includes('?') ? '&' : '?'}teamId=${encodeURIComponent(teamId)}`;
}

/** @returns {boolean} may this run deploy at all? */
export function deployEnabled(env = process.env) {
  const raw = String(env?.[ALLOW_DEPLOY_ENV] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

// ───────────────────────────────────────────────────────────────────────────
// WHAT GETS UPLOADED
// ───────────────────────────────────────────────────────────────────────────

/**
 * Read `.vercelignore` (or `.gitignore` as a fallback) into a prefix list.
 *
 * ⚠️ NOT A GLOB ENGINE. A real gitignore implementation is a dependency-shaped
 * amount of code, and getting it 90% right is worse than not having it: the 10%
 * is a file that quietly does not ship. This handles the two forms that cover
 * nearly every real ignore file — a plain path and a trailing-slash directory —
 * and anything with a `*` in it is reported in `unsupportedPatterns` so the user
 * finds out from the plan rather than from a broken preview.
 */
export function readIgnores(root, { readFileImpl = readFileSync } = {}) {
  for (const name of ['.vercelignore', '.gitignore']) {
    let text = null;
    try { text = String(readFileImpl(join(root, name), 'utf8')); } catch { continue; }
    const lines = text.split(/\r?\n/).map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && !l.startsWith('!'));
    const unsupported = lines.filter((l) => l.includes('*') || l.includes('?'));
    const prefixes = lines
      .filter((l) => !unsupported.includes(l))
      .map((l) => l.replace(/^\.?\//, '').replace(/\/$/, ''))
      .filter(Boolean);
    return { source: name, prefixes, unsupportedPatterns: unsupported };
  }
  return { source: null, prefixes: [], unsupportedPatterns: [] };
}

/** Is this workspace-relative path covered by an ignore prefix? */
export function isIgnored(rel, prefixes) {
  return prefixes.some((p) => rel === p || rel.startsWith(`${p}/`));
}

const mb = (n) => `${(n / (1024 * 1024)).toFixed(1)}MB`;

/** The ceiling in bytes, and the lever for a project that legitimately exceeds it. */
export function maxTotalBytes(env = process.env) {
  const raw = Number(env?.ACUVO_DEPLOY_MAX_MB);
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw * 1024 * 1024) : MAX_TOTAL_BYTES;
}

/**
 * Walk the workspace and hash everything that will be uploaded.
 *
 * ⚠️ `refusedCommitPath` IS THE SAME LIST `git_commit` USES, imported rather
 * than copied. `read-window.mjs` once kept its own second copy and the two
 * DISAGREED — each covered holes the other left — so which of a user's secrets
 * leaked depended on which verb happened to run. A `.env` uploaded to a preview
 * deployment is strictly worse than one committed: the commit is on your disk
 * until you push, the upload is on someone else's the moment it lands.
 *
 * ── ⭐ TWO PASSES, AND THE SECOND ONE IS WHY ────────────────────────────────
 *
 * Pass one only STATS. Pass two reads the bytes. That ordering was forced by a
 * measurement, not by tidiness: run against the real `console/` workspace this
 * refused at "the upload would be over 40.0MB" — a true statement that tells the
 * user nothing they can act on. Having the whole size map before deciding means
 * the refusal can name the three directories responsible (`15.9MB lib`,
 * `12.5MB .bench-out`, `12.1MB scripts`), which is the difference between a wall
 * and an instruction.
 *
 * ⚠️ It also stops the old version reading ~40MB into memory before discovering
 * it was going to refuse.
 */
export function collectFiles(root, {
  readdirImpl = readdirSync,
  statImpl = statSync,
  readFileImpl = readFileSync,
  env = process.env,
} = {}) {
  const ignores = readIgnores(root, { readFileImpl });
  const found = [];
  const skippedSecrets = [];
  /** top-level directory → bytes, so a refusal can point at the culprit. */
  const byTop = new Map();

  const walk = (dir, prefix, depth) => {
    if (depth > 24) return;
    let entries;
    try { entries = readdirImpl(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const name = e.name;
      const rel = prefix ? `${prefix}/${name}` : name;
      if (isIgnored(rel, ignores.prefixes)) continue;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        walk(join(dir, name), rel, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;                       // symlinks, sockets, fifos
      const refusal = refusedCommitPath(rel);
      if (refusal) { skippedSecrets.push(rel); continue; }
      let size = 0;
      try { size = statImpl(join(dir, name)).size; } catch { continue; }
      found.push({ rel, dir, name, size });
      const top = prefix ? prefix.split('/')[0] : '(files at the root)';
      byTop.set(top, (byTop.get(top) ?? 0) + size);
    }
  };
  walk(root, '', 0);

  if (found.length === 0) {
    return { ok: false, error: 'there is nothing to deploy — every file here is ignored, skipped or a credential.' };
  }

  /** The three biggest directories, phrased as something to put in .vercelignore. */
  const worst = [...byTop.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([k, v]) => `${mb(v)} ${k}`).join(' · ');
  const ceiling = maxTotalBytes(env);
  const totalBytes = found.reduce((n, f) => n + f.size, 0);

  const tooBig = found.find((f) => f.size > MAX_FILE_BYTES);
  if (tooBig) {
    return { ok: false, error: `${tooBig.rel} is ${mb(tooBig.size)}, over the ${mb(MAX_FILE_BYTES)} per-file limit. Add it to .vercelignore — a preview does not need it.` };
  }
  if (found.length > MAX_FILES) {
    return { ok: false, error: `${found.length} files would be uploaded, over the ${MAX_FILES} limit. Biggest: ${worst}. Add what the build does not need to .vercelignore before paying for a build.` };
  }
  if (totalBytes > ceiling) {
    return {
      ok: false,
      error: `the upload would be ${mb(totalBytes)}, over the ${mb(ceiling)} limit. Biggest: ${worst}. `
        + 'Add what the build does not need to .vercelignore, or raise the limit with ACUVO_DEPLOY_MAX_MB.',
    };
  }

  const files = [];
  for (const f of found) {
    let data;
    try { data = readFileImpl(join(f.dir, f.name)); } catch { continue; }
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    files.push({ file: f.rel, sha: createHash('sha1').update(buf).digest('hex'), size: buf.length, data: buf });
  }
  return {
    ok: true,
    files,
    totalBytes: files.reduce((n, f) => n + f.size, 0),
    ignoreSource: ignores.source,
    unsupportedPatterns: ignores.unsupportedPatterns,
    skippedSecrets,
    largest: worst,
  };
}

/**
 * Which framework Vercel should build this as.
 *
 * ⚠️ `null` IS A REAL ANSWER, not a failure — it means "static", which is what
 * a folder of HTML is and what Vercel does correctly with no settings at all.
 */
export function detectFramework(root, { readFileImpl = readFileSync } = {}) {
  let pkg;
  try { pkg = JSON.parse(String(readFileImpl(join(root, 'package.json'), 'utf8'))); } catch { return null; }
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  if (deps.next) return 'nextjs';
  if (deps.nuxt || deps.nuxt3) return 'nuxtjs';
  if (deps['@sveltejs/kit']) return 'sveltekit';
  if (deps.astro) return 'astro';
  if (deps.gatsby) return 'gatsby';
  if (deps['react-scripts']) return 'create-react-app';
  if (deps['@remix-run/dev']) return 'remix';
  if (deps.vite) return 'vite';
  return null;
}

/**
 * A Vercel project name derived from the folder.
 *
 * ⚠️ VERCEL'S RULES, NOT OURS: lowercase, ≤100 chars, `a-z0-9._-` only, and no
 * `---` run. A name that violates them is a 400 AFTER the files have uploaded,
 * which is a slow way to learn about a capital letter.
 */
export function projectNameFor(root) {
  const raw = basename(String(root ?? '')) || 'acuvo-preview';
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{3,}/g, '--').replace(/^[-.]+|[-.]+$/g, '').slice(0, 100);
  return cleaned || 'acuvo-preview';
}

// ───────────────────────────────────────────────────────────────────────────
// THE FREE HALF — WHAT IT WILL COST, BEFORE ANYTHING IS SPENT
// ───────────────────────────────────────────────────────────────────────────

/**
 * ⭐ THE SENTENCE THE WHOLE MODULE EXISTS TO PRINT.
 *
 * One build, stated in the unit Vercel bills in, before the POST. Not "this may
 * incur charges" — a number, so a person reading the transcript can decide.
 */
export function costStatement() {
  return 'This will consume exactly 1 Vercel BUILD on the account that owns the token. '
    + 'Hobby allows 100 deployments a day; on Pro a build is metered. There is no undo — '
    + 'once the request lands, the build has happened.';
}

/**
 * Everything a person needs to approve the spend, computed with no network.
 *
 * ⚠️ NO NETWORK IS A DESIGN CONSTRAINT, not an accident. If the plan touched
 * Vercel then "just show me what you would do" would need credentials, and the
 * pre-approval step would be the thing that fails on a machine with no token —
 * so people would skip it.
 */
export function planDeploy(root, { project = null, env = process.env, ...io } = {}) {
  const collected = collectFiles(root, { ...io, env });
  if (!collected.ok) return collected;
  const linked = readLinkedProject(root, io);
  const name = project ? projectNameFor(project) : projectNameFor(root);
  const framework = detectFramework(root, io);
  return {
    ok: true,
    action: 'plan',
    project: name,
    /** ⭐ Say WHICH project will be deployed to, before a build is spent on it. */
    linkedProjectId: linked?.projectId ?? null,
    teamId: teamIdFor(root, { env, ...io }),
    target: 'preview',
    framework,
    fileCount: collected.files.length,
    totalBytes: collected.totalBytes,
    ignoreSource: collected.ignoreSource,
    unsupportedPatterns: collected.unsupportedPatterns,
    skippedSecrets: collected.skippedSecrets,
    enabled: deployEnabled(env),
    cost: costStatement(),
    nextStep: deployEnabled(env)
      ? 'To go ahead: vercel_preview { "action": "deploy", "acknowledgeBuildCost": true }'
      : `Deploying is turned off. The operator must set ${ALLOW_DEPLOY_ENV}=1 before this run can spend a build.`,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// THE PAID HALF
// ───────────────────────────────────────────────────────────────────────────

async function api(path, { token, method = 'GET', body = null, headers = {}, timeout = API_TIMEOUT_MS, fetchImpl = fetch }) {
  let res;
  try {
    res = await fetchImpl(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'user-agent': 'acuvo-code',
        ...(body && !(body instanceof Uint8Array) ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body instanceof Uint8Array ? body : (body ? JSON.stringify(body) : undefined),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    return { ok: false, error: `could not reach Vercel: ${err?.cause?.code ?? err?.name ?? err}` };
  }
  const text = await res.text().catch(() => '');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* some endpoints answer empty */ }
  if (!res.ok) {
    const code = json?.error?.code ?? '';
    const message = json?.error?.message ?? text.slice(0, 300) ?? '';
    return {
      ok: false,
      status: res.status,
      code,
      missing: json?.error?.missing ?? null,
      error: `Vercel returned HTTP ${res.status}${code ? ` (${code})` : ''}${message ? `: ${message}` : ''}`,
    };
  }
  return { ok: true, status: res.status, json };
}

/**
 * Upload one file's bytes, keyed by its SHA-1.
 *
 * ⭐ THE DIGEST IS THE DEDUPE. Vercel stores blobs by SHA, so re-deploying a
 * project whose `node_modules`-free source barely changed re-uploads only the
 * files that actually differ — which is why this uses the two-step upload rather
 * than inlining base64 into the deployment body. It is also the only path that
 * handles binary assets without a 33% base64 tax.
 */
export async function uploadFile(file, { token, fetchImpl = fetch, teamId = null } = {}) {
  return api(scope('/v2/files', teamId), {
    token,
    method: 'POST',
    body: file.data,
    timeout: UPLOAD_TIMEOUT_MS,
    fetchImpl,
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(file.size),
      'x-vercel-digest': file.sha,
    },
  });
}

/**
 * Upload every file, a few at a time.
 *
 * ⚠️ CONCURRENCY 4, NOT `Promise.all` OVER 3000 FILES. Node will happily open
 * three thousand sockets and Vercel will happily rate-limit all of them, which
 * fails a deploy for a reason that has nothing to do with the code being
 * deployed. The first failure aborts: a partial upload guarantees a
 * `missing_files` rejection, so continuing only wastes bandwidth.
 */
export async function uploadFiles(files, { token, fetchImpl = fetch, concurrency = 4, onProgress = null, teamId = null } = {}) {
  const queue = [...files];
  let done = 0;
  let failure = null;
  const worker = async () => {
    for (;;) {
      if (failure) return;
      const f = queue.shift();
      if (!f) return;
      const r = await uploadFile(f, { token, fetchImpl, teamId });
      if (!r.ok) { failure = `uploading ${f.file}: ${r.error}`; return; }
      done += 1;
      if (onProgress) onProgress(done, files.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, files.length)) }, worker));
  if (failure) return { ok: false, error: failure };
  return { ok: true, uploaded: done };
}

/**
 * Create the deployment.
 *
 * ⚠️⚠️ THERE IS NO `target` PARAMETER, AND THAT IS THE SAFETY PROPERTY. Vercel
 * reads an absent `target` as a preview. Adding an optional one — even
 * defaulting to preview — would mean a production deploy is one wrong argument
 * away, and this agent must not have that argument to get wrong.
 * `test/vercel.test.mjs` asserts the request body has no `target` key at all.
 */
export async function createPreviewDeployment({
  token, project, files, framework = null, fetchImpl = fetch, meta = {},
  teamId = null, projectId = null,
}) {
  const body = {
    name: project,
    /**
     * ⭐ THE LINKED ID WINS OVER THE FOLDER NAME. `project` accepts an id or a
     * name; when `.vercel/project.json` exists the user has already told us
     * which project this is, and honouring it is what makes the preview inherit
     * their environment variables instead of being a stranger.
     */
    project: projectId || project,
    files: files.map((f) => ({ file: f.file, sha: f.sha, size: f.size })),
    projectSettings: { framework },
    meta: { deployedBy: 'acuvo-code', ...meta },
  };
  /**
   * `skipAutoDetectionConfirmation=1` — without it, a first deployment of a
   * project whose framework Vercel infers differently answers 400 asking a human
   * to confirm, and there is no human in this loop. The files are already
   * uploaded by then, so the failure is both confusing and paid for.
   */
  const r = await api(scope('/v13/deployments?skipAutoDetectionConfirmation=1', teamId), { token, method: 'POST', body, fetchImpl });
  if (!r.ok) {
    if (r.code === 'missing_files') {
      return { ok: false, error: `Vercel did not receive ${(r.missing ?? []).length || 'some'} of the uploaded files. Retry — this is an upload race, not a problem with the code.` };
    }
    return r;
  }
  const d = r.json ?? {};
  return {
    ok: true,
    id: d.id,
    url: d.url ? `https://${d.url}` : null,
    inspectorUrl: d.inspectorUrl ?? null,
    readyState: d.readyState ?? d.status ?? 'QUEUED',
  };
}

/** One status read. Free, and safe to call on somebody else's deployment id. */
export async function getDeployment(id, { token, fetchImpl = fetch, teamId = null } = {}) {
  const r = await api(scope(`/v13/deployments/${encodeURIComponent(id)}`, teamId), { token, fetchImpl });
  if (!r.ok) return r;
  const d = r.json ?? {};
  return {
    ok: true,
    id: d.id ?? id,
    // ⚠️ BOTH KEYS. Older deployments answer `readyState`, newer ones `status`,
    // and a poll that reads only one spins until the timeout on the other.
    readyState: d.readyState ?? d.status ?? 'UNKNOWN',
    url: d.url ? `https://${d.url}` : null,
    inspectorUrl: d.inspectorUrl ?? null,
    target: d.target ?? null,
    error: d.errorMessage ?? null,
  };
}

const TERMINAL = new Set(['READY', 'ERROR', 'CANCELED', 'DELETED']);

/**
 * Wait for the build.
 *
 * ⚠️ THE TIMEOUT RETURNS THE DEPLOYMENT, NOT AN ERROR OBJECT WITH NOTHING IN IT.
 * A build that is still running after fifteen minutes has not failed — the money
 * is spent and the URL will exist shortly — so the honest answer is "still
 * building, here is where to watch it", not "deploy failed".
 */
export async function pollDeployment(id, {
  token, fetchImpl = fetch, sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)),
  nowImpl = Date.now, timeout = POLL_TIMEOUT_MS, interval = POLL_INTERVAL_MS, onState = null,
  teamId = null,
} = {}) {
  const started = nowImpl();
  let last = null;
  for (;;) {
    const d = await getDeployment(id, { token, fetchImpl, teamId });
    if (!d.ok) return d;
    if (onState && d.readyState !== last) onState(d.readyState);
    last = d.readyState;
    if (TERMINAL.has(d.readyState)) return { ...d, timedOut: false };
    if (nowImpl() - started >= timeout) return { ...d, timedOut: true };
    await sleepImpl(interval);
  }
}

/**
 * The build log, newest last.
 *
 * ⭐ `direction=backward` + a limit is how you read the END of a build log
 * without pulling the megabytes of successful `npm install` output in front of
 * it — the same argument `gh_run`'s "failed" action makes about CI.
 */
export async function getBuildLogs(idOrUrl, { token, fetchImpl = fetch, limit = 60, errorsOnly = false, teamId = null } = {}) {
  const r = await api(
    scope(`/v3/deployments/${encodeURIComponent(idOrUrl)}/events?builds=1&direction=backward&limit=${Math.max(1, Math.min(200, limit))}`, teamId),
    { token, fetchImpl },
  );
  if (!r.ok) return r;
  const events = Array.isArray(r.json) ? r.json : (r.json?.events ?? []);
  const lines = events
    .map((e) => ({ type: String(e?.type ?? ''), text: String(e?.text ?? e?.payload?.text ?? '').replace(/\s+$/, '') }))
    .filter((e) => e.text)
    .filter((e) => !errorsOnly || /error|stderr|fatal|exit/i.test(e.type))
    .reverse();
  return { ok: true, lines };
}

// ───────────────────────────────────────────────────────────────────────────
// THE ORCHESTRATOR
// ───────────────────────────────────────────────────────────────────────────

/**
 * Code on disk → a preview URL, or the log that says why not.
 *
 * @returns {Promise<object>} always `{ ok }`-shaped; `ok:false` carries `error`
 *   and, when the build itself failed, `logs`.
 */
export async function deployPreview(root, {
  env = process.env, project = null, token = null, fetchImpl = fetch,
  acknowledgeBuildCost = false, onProgress = null, onState = null,
  sleepImpl, nowImpl, timeout, interval, ...io
} = {}) {
  /**
   * ⚠️ GATE 1 — THE OPERATOR'S SWITCH, CHECKED HERE AS WELL AS AT THE OFFER.
   * `git.mjs:gitPush` makes this argument at length and cites the test: a model
   * can call a tool it was never shown, so the offer is not a boundary.
   */
  if (!deployEnabled(env)) {
    return {
      ok: false,
      error: `deploying is turned off. A Vercel deploy spends a paid build on the operator's account, so this agent only does it when asked for by name: set ${ALLOW_DEPLOY_ENV}=1 in the environment.`,
    };
  }
  /**
   * ⚠️ GATE 2 — THE PRICE MUST HAVE BEEN READ. The plan is free and states the
   * cost; this flag is the model saying it saw it. Without it the answer is the
   * plan, which means the wrong call still produces something useful instead of
   * an error the model has to burn a round recovering from.
   */
  if (acknowledgeBuildCost !== true) {
    const plan = planDeploy(root, { project, env, ...io });
    return {
      ok: false,
      error: 'a deploy costs a build and has not been acknowledged. ' + costStatement()
        + ' Call again with acknowledgeBuildCost: true if that is acceptable.',
      plan: plan.ok ? plan : undefined,
    };
  }

  const creds = token ? { ok: true, token } : findToken({ env, ...io });
  if (!creds.ok) return creds;

  const collected = collectFiles(root, { ...io, env });
  if (!collected.ok) return collected;

  const name = project ? projectNameFor(project) : projectNameFor(root);
  const framework = detectFramework(root, io);
  const teamId = teamIdFor(root, { env, ...io });
  /**
   * ⚠️ AN EXPLICIT `project` OVERRIDES THE LINK. Someone who names a project is
   * saying "not the linked one" — silently deploying elsewhere would be the
   * ignore-rather-than-refuse failure `target` is guarded against.
   */
  const projectId = project ? null : (readLinkedProject(root, io)?.projectId ?? null);

  const up = await uploadFiles(collected.files, { token: creds.token, fetchImpl, onProgress, teamId });
  if (!up.ok) return up;

  const created = await createPreviewDeployment({
    token: creds.token, project: name, projectId, files: collected.files, framework, fetchImpl, teamId,
  });
  if (!created.ok) return created;

  const final = await pollDeployment(created.id, {
    token: creds.token, fetchImpl, sleepImpl, nowImpl, timeout, interval, onState, teamId,
  });
  if (!final.ok) return { ...final, id: created.id, inspectorUrl: created.inspectorUrl };

  const base = {
    project: projectId || name,
    target: 'preview',
    id: created.id,
    url: final.url ?? created.url,
    inspectorUrl: final.inspectorUrl ?? created.inspectorUrl,
    readyState: final.readyState,
    fileCount: collected.files.length,
    skippedSecrets: collected.skippedSecrets,
  };

  if (final.readyState === 'READY') return { ok: true, ...base, buildsSpent: 1 };

  if (final.timedOut) {
    return {
      ok: true, ...base, buildsSpent: 1, stillBuilding: true,
      note: 'the build is still running after the wait limit. The build has been paid for either way — watch it at the inspector URL.',
    };
  }

  /**
   * ⚠️ THE LOG IS FETCHED HERE, NOT LEFT FOR A SECOND VERB. "Deployment failed"
   * is a status; the last forty lines of the build output are a fix. The build
   * is already paid for — the reason is the only thing left to recover from it.
   */
  const logs = await getBuildLogs(created.id, { token: creds.token, fetchImpl, limit: 60, teamId });
  return {
    ok: false,
    ...base,
    buildsSpent: 1,
    error: `the build finished as ${final.readyState}${final.error ? `: ${final.error}` : ''}`,
    logs: logs.ok ? logs.lines : [],
    logsError: logs.ok ? null : logs.error,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// THE OFFER
// ───────────────────────────────────────────────────────────────────────────

export const VERCEL_TOOL_NAME = 'vercel_preview';

/**
 * ⭐ MENTIONED ONLY WHEN IT COULD RUN — the argument `gitPushToolNames` makes.
 * A schema the model is never shown costs zero tokens on every round, so a
 * default install pays nothing for a verb it has not enabled, and the tokens are
 * spent only by someone who asked for the capability.
 *
 * ⚠️ AND `plan` IS BEHIND THE SAME GATE, deliberately. A free preflight for a
 * spend the run is not allowed to make is the dead button this package refuses
 * to ship: the model would compute a cost, offer it, and then be refused.
 */
export function vercelToolNames(env = process.env, { allowRun = true } = {}) {
  return allowRun && deployEnabled(env) ? [VERCEL_TOOL_NAME] : [];
}

export function vercelToolSchemas() {
  return [{
    type: 'function',
    function: {
      name: VERCEL_TOOL_NAME,
      description: [
        'Deploy this workspace to a Vercel PREVIEW URL — the one artefact a non-programmer can open and check.',
        '⚠️ A deploy SPENDS A PAID BUILD on the user\'s account and cannot be undone, so it is two calls, not one:',
        'action "plan" first (free, no network — it reports the file count and the exact cost), then action "deploy"',
        'with acknowledgeBuildCost: true. Never deploy without planning first, and never deploy twice for one change.',
        'This agent CANNOT deploy to production, by construction: there is no target parameter and none is ever sent.',
        'Use "status" and "logs" (both free) to check or diagnose a deployment you already made.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['plan', 'deploy', 'status', 'logs'],
            description: '"plan" = free preflight and the price. "deploy" = spend one build. "status"/"logs" = read an existing deployment (needs id).',
          },
          acknowledgeBuildCost: {
            type: 'boolean',
            description: 'deploy only — must be true. Set it only after "plan" has reported the cost and the task actually calls for a live URL.',
          },
          project: {
            type: 'string',
            description: 'Vercel project name. Omit to use the workspace folder name; an unknown name creates a new project.',
          },
          id: { type: 'string', description: 'status / logs — the deployment id or hostname returned by deploy.' },
          errorsOnly: { type: 'boolean', description: 'logs only — return just the error, stderr and fatal lines.' },
          limit: { type: 'number', description: 'logs only — how many lines, 1–200 (default 60).' },
        },
        required: ['action'],
      },
    },
  }];
}

/** Plan then run — the single entry point the dispatcher calls. */
export async function executeVercel(root, args = {}, { env = process.env, fetchImpl = fetch, ...io } = {}) {
  const action = String(args?.action ?? '').trim().toLowerCase();

  /**
   * ⚠️ REFUSED, NOT IGNORED. Dropping the word "production" out of a request and
   * quietly doing something else is how somebody comes to believe they shipped.
   * If the model asked for production it must be told plainly that it cannot.
   */
  if (args?.target !== undefined) {
    return { ok: false, error: 'this agent only makes PREVIEW deployments — there is no target parameter. A production deploy is a human decision, made with the Vercel CLI or dashboard.' };
  }

  /** ⚠️ Validated here, not only in the enum: the schema is not a boundary. */
  if (!['plan', 'deploy', 'status', 'logs'].includes(action)) {
    return { ok: false, error: `"${args?.action ?? ''}" is not a vercel_preview action. Use plan, deploy, status or logs.` };
  }

  if (!deployEnabled(env)) {
    return { ok: false, error: `Vercel deploys are turned off. Set ${ALLOW_DEPLOY_ENV}=1 to enable them — a deploy spends a paid build on the operator's account.` };
  }

  if (action === 'plan') return planDeploy(root, { project: args.project ?? null, env, ...io });

  if (action === 'deploy') {
    return deployPreview(root, {
      env,
      fetchImpl,
      project: args.project ?? null,
      acknowledgeBuildCost: args.acknowledgeBuildCost === true,
      ...io,
    });
  }

  const id = String(args?.id ?? '').trim();
  if (!id) return { ok: false, error: `${action} needs the deployment id (or hostname) that deploy returned.` };
  const creds = findToken({ env, ...io });
  if (!creds.ok) return creds;

  const teamId = teamIdFor(root, { env, ...io });
  if (action === 'status') return getDeployment(id, { token: creds.token, fetchImpl, teamId });
  return getBuildLogs(id, {
    token: creds.token,
    fetchImpl,
    teamId,
    limit: Number(args?.limit) || 60,
    errorsOnly: args?.errorsOnly === true,
  });
}

/** What to tell the user once a preview is up. */
export function nextSteps({ url, inspectorUrl, project }) {
  return [
    '',
    '  Preview is live. Nothing was deployed to production.',
    '',
    `    ${url}`,
    inspectorUrl ? `    build log: ${inspectorUrl}` : '',
    '',
    `  Project: ${project} · this cost 1 build.`,
  ].filter(Boolean);
}
