/**
 * ── ⚠️⚠️ EVERY TEST HERE IS MOCKED, AND THAT IS A BUDGET DECISION ───────────
 *
 * A Vercel deployment is a PAID BUILD on Roman's personal account. A suite that
 * deployed for real would spend money on every `npm test`, on every machine,
 * forever — so `fetchImpl` is injected everywhere and the real `fetch` is never
 * reachable from this file. The one end-to-end proof is a command a human runs
 * deliberately, once, and it is written down in the report rather than here.
 *
 * ⭐ THE THREE PROPERTIES WORTH THE FILE: the deploy is never implicit, the cost
 * is stated before it is spent, and `target` never leaves this machine.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import {
  ALLOW_DEPLOY_ENV, deployEnabled, findToken, collectFiles, readIgnores, isIgnored,
  detectFramework, projectNameFor, planDeploy, costStatement, uploadFiles,
  readLinkedProject, teamIdFor, maxTotalBytes, MAX_TOTAL_BYTES,
  createPreviewDeployment, getDeployment, pollDeployment, getBuildLogs, deployPreview,
  vercelToolNames, vercelToolSchemas, executeVercel, VERCEL_TOOL_NAME,
} from '../lib/vercel.mjs';
import { executeToolCall, toolNamesForRounds, TOOL_SCHEMAS, TOOL_NAMES } from '../lib/tools.mjs';

// ── scaffolding ────────────────────────────────────────────────────────────

const made = [];
function ws(files = {}) {
  const d = mkdtempSync(join(realpathSync(tmpdir()), 'acuvo-vercel-'));
  made.push(d);
  for (const [rel, body] of Object.entries(files)) {
    const full = join(d, ...rel.split('/'));
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  return d;
}
const cleanup = () => { for (const d of made.splice(0)) { try { rmSync(d, { recursive: true, force: true, maxRetries: 3 }); } catch { /* windows */ } } };

const ON = { [ALLOW_DEPLOY_ENV]: '1', VERCEL_TOKEN: 'tok_test' };
const OFF = { VERCEL_TOKEN: 'tok_test' };

const resp = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body ?? null)),
});

/** A fetch that never touches a network and records every call. */
function recorder(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body });
    return handler(String(url), init, calls.length);
  };
  fn.calls = calls;
  return fn;
}

const EXPLODE = () => { throw new Error('the network must not be touched here'); };
const noSleep = async () => {};

// ── the gate ───────────────────────────────────────────────────────────────

test('⭐⭐ THE VERB IS NOT EVEN MENTIONED UNLESS THE OPERATOR TURNS IT ON', () => {
  assert.deepEqual(vercelToolNames(OFF), [], 'a schema for a spend the run cannot make is a dead button');
  assert.deepEqual(vercelToolNames(ON), [VERCEL_TOOL_NAME]);
  assert.deepEqual(vercelToolNames(ON, { allowRun: false }), [], '--no-run must withhold it too');
  for (const v of ['1', 'true', 'yes', 'on', 'ON']) assert.equal(deployEnabled({ [ALLOW_DEPLOY_ENV]: v }), true, v);
  for (const v of ['', '0', 'false', 'no', undefined]) assert.equal(deployEnabled({ [ALLOW_DEPLOY_ENV]: v }), false, String(v));
});

test('⭐⭐ AND THE GATE HOLDS AT THE DISPATCHER, NOT ONLY AT THE OFFER', async (t) => {
  t.after(cleanup);
  const root = ws({ 'index.html': '<h1>hi</h1>' });
  // A model can emit a call for a tool it was never shown — resumed session,
  // stale tool list echoed by a provider. The offer is not a boundary.
  const r = await executeVercel(root, { action: 'deploy', acknowledgeBuildCost: true }, { env: OFF, fetchImpl: EXPLODE });
  assert.equal(r.ok, false);
  assert.match(r.error, /ACUVO_ALLOW_DEPLOY/);

  // ⚠️ and the same again one layer down, called directly.
  const d = await deployPreview(root, { env: OFF, acknowledgeBuildCost: true, fetchImpl: EXPLODE });
  assert.equal(d.ok, false);
  assert.match(d.error, /ACUVO_ALLOW_DEPLOY/);
});

test('⭐⭐ A DEPLOY WITHOUT AN ACKNOWLEDGED COST IS REFUSED — AND ANSWERS WITH THE PRICE', async (t) => {
  t.after(cleanup);
  const root = ws({ 'index.html': '<h1>hi</h1>' });
  const r = await deployPreview(root, { env: ON, fetchImpl: EXPLODE });   // no acknowledgeBuildCost
  assert.equal(r.ok, false);
  assert.match(r.error, /1 Vercel BUILD/);
  assert.equal(r.plan.fileCount, 1, 'the refusal carries the plan, so the next round is not wasted re-planning');
  assert.equal(r.plan.target, 'preview');
});

test('acknowledgeBuildCost must be exactly true — a truthy string is not consent', async (t) => {
  t.after(cleanup);
  const root = ws({ 'index.html': 'x' });
  for (const v of ['true', 1, 'yes', {}]) {
    const r = await executeVercel(root, { action: 'deploy', acknowledgeBuildCost: v }, { env: ON, fetchImpl: EXPLODE });
    assert.equal(r.ok, false, `${JSON.stringify(v)} must not count as consent`);
    assert.match(r.error, /acknowledged/);
  }
});

// ── production is unreachable ──────────────────────────────────────────────

test('⭐⭐⭐ THE DEPLOYMENT BODY HAS NO `target` KEY AT ALL', async () => {
  const fetchImpl = recorder(() => resp(200, { id: 'dpl_1', url: 'x.vercel.app', readyState: 'QUEUED' }));
  const r = await createPreviewDeployment({
    token: 't', project: 'p', framework: 'nextjs', fetchImpl,
    files: [{ file: 'index.html', sha: 'abc', size: 3 }],
  });
  assert.equal(r.ok, true);
  const body = JSON.parse(fetchImpl.calls[0].body);
  assert.equal('target' in body, false, 'Vercel reads an absent target as preview — sending one is how production happens by accident');
  assert.equal(body.name, 'p');
  assert.equal(body.projectSettings.framework, 'nextjs');
  assert.deepEqual(body.files, [{ file: 'index.html', sha: 'abc', size: 3 }]);
  assert.match(fetchImpl.calls[0].url, /skipAutoDetectionConfirmation=1/);
});

test('⭐⭐ ASKING FOR PRODUCTION IS REFUSED, NOT SILENTLY DOWNGRADED', async (t) => {
  t.after(cleanup);
  const root = ws({ 'index.html': 'x' });
  const r = await executeVercel(root, { action: 'deploy', acknowledgeBuildCost: true, target: 'production' }, { env: ON, fetchImpl: EXPLODE });
  assert.equal(r.ok, false);
  assert.match(r.error, /only makes PREVIEW deployments/);
});

test('an unknown action is refused by the dispatcher, not just by the enum', async (t) => {
  t.after(cleanup);
  const root = ws({ 'index.html': 'x' });
  const r = await executeVercel(root, { action: 'promote' }, { env: ON, fetchImpl: EXPLODE });
  assert.equal(r.ok, false);
  assert.match(r.error, /not a vercel_preview action/);
});

// ── the free preflight ─────────────────────────────────────────────────────

test('⭐⭐ `plan` TOUCHES NO NETWORK AND STATES THE PRICE', async (t) => {
  t.after(cleanup);
  const root = ws({ 'index.html': 'hello', 'package.json': JSON.stringify({ dependencies: { next: '15' } }) });
  const p = await executeVercel(root, { action: 'plan' }, { env: ON, fetchImpl: EXPLODE });
  assert.equal(p.ok, true);
  assert.equal(p.fileCount, 2);
  assert.equal(p.framework, 'nextjs');
  assert.equal(p.target, 'preview');
  assert.equal(p.cost, costStatement());
  assert.match(p.cost, /exactly 1 Vercel BUILD/);
  assert.match(p.nextStep, /acknowledgeBuildCost/);
  assert.ok(p.totalBytes > 0);
});

test('the plan says so when deploying is switched off, rather than pretending', (t) => {
  t.after(cleanup);
  const root = ws({ 'index.html': 'hello' });
  const p = planDeploy(root, { env: OFF });
  assert.equal(p.enabled, false);
  assert.match(p.nextStep, /ACUVO_ALLOW_DEPLOY=1/);
});

// ── what is and is not uploaded ────────────────────────────────────────────

test('⭐⭐⭐ A CREDENTIAL FILE IS NEVER UPLOADED', (t) => {
  t.after(cleanup);
  const root = ws({
    'index.html': 'x',
    '.env': 'OPENROUTER_API_KEY=sk-live',
    '.env.local': 'SUPABASE_SERVICE_ROLE=x',
    'certs/server.pem': '-----BEGIN',
    'src/app.js': 'ok',
  });
  const c = collectFiles(root);
  assert.equal(c.ok, true);
  const names = c.files.map((f) => f.file).sort();
  assert.deepEqual(names, ['index.html', 'src/app.js']);
  assert.equal(c.skippedSecrets.length, 3, 'and it reports what it withheld — a silent skip is how you find out later');
});

test('.vercelignore is honoured, and a glob it cannot do is reported rather than half-applied', (t) => {
  t.after(cleanup);
  const root = ws({
    '.vercelignore': '# junk\nscratch/\nnotes.md\n*.log\n',
    'index.html': 'x',
    'notes.md': 'x',
    'scratch/big.bin': 'x',
    'keep/a.js': 'x',
  });
  const ig = readIgnores(root);
  assert.equal(ig.source, '.vercelignore');
  assert.deepEqual(ig.unsupportedPatterns, ['*.log']);
  assert.equal(isIgnored('scratch/big.bin', ig.prefixes), true);
  const c = collectFiles(root);
  assert.deepEqual(c.files.map((f) => f.file).sort(), ['.vercelignore', 'index.html', 'keep/a.js']);
});

test('node_modules and .next are skipped; dist is NOT — it is often the deployable artefact', (t) => {
  t.after(cleanup);
  const root = ws({
    'index.html': 'x',
    'node_modules/left-pad/index.js': 'x',
    '.next/BUILD_ID': 'x',
    'dist/bundle.js': 'x',
  });
  const c = collectFiles(root);
  assert.deepEqual(c.files.map((f) => f.file).sort(), ['dist/bundle.js', 'index.html']);
});

test('⭐⭐ A SIZE REFUSAL NAMES THE CULPRIT — measured against a real workspace', (t) => {
  t.after(cleanup);
  // ⚠️ THIS IS THE BUG THE TWO-PASS WALK FIXED. Run against the real `console/`
  // checkout the first version said only "the upload would be over 40.0MB",
  // which is true and useless. The real breakdown there was
  // `15.9MB lib · 12.5MB .bench-out · 12.1MB scripts`.
  const root = ws({
    'index.html': 'x',
    'assets/a.bin': 'a'.repeat(600_000),
    'assets/b.bin': 'b'.repeat(600_000),
    'docs/c.md': 'c'.repeat(50_000),
  });
  const env = { ACUVO_DEPLOY_MAX_MB: '1' };
  const c = collectFiles(root, { env });
  assert.equal(c.ok, false);
  assert.match(c.error, /over the 1\.0MB limit/);
  assert.match(c.error, /Biggest: 1\.1MB assets/, 'a wall with no instruction is not a refusal a user can act on');
  assert.match(c.error, /ACUVO_DEPLOY_MAX_MB/, 'and a hard ceiling with no lever is a capability ceiling');

  // ⭐ the lever really works, or the sentence above is a lie.
  const ok = collectFiles(root, { env: { ACUVO_DEPLOY_MAX_MB: '4' } });
  assert.equal(ok.ok, true);
  assert.equal(ok.files.length, 4);
  assert.match(ok.largest, /assets/);

  assert.equal(maxTotalBytes({}), MAX_TOTAL_BYTES);
  assert.equal(maxTotalBytes({ ACUVO_DEPLOY_MAX_MB: 'lots' }), MAX_TOTAL_BYTES, 'nonsense falls back rather than becoming NaN');
  assert.equal(maxTotalBytes({ ACUVO_DEPLOY_MAX_MB: '-5' }), MAX_TOTAL_BYTES);
});

test('an empty deployment is refused before any money moves', (t) => {
  t.after(cleanup);
  const root = ws({ '.env': 'SECRET=1' });
  const c = collectFiles(root);
  assert.equal(c.ok, false);
  assert.match(c.error, /nothing to deploy/);
});

test('the sha is the sha of the bytes, because Vercel keys the upload on it', (t) => {
  t.after(cleanup);
  const body = 'const a = 1;\n';
  const root = ws({ 'a.js': body });
  const c = collectFiles(root);
  assert.equal(c.files[0].sha, createHash('sha1').update(Buffer.from(body)).digest('hex'));
  assert.equal(c.files[0].size, Buffer.byteLength(body));
});

test('framework detection, and the project name obeys Vercel\'s rules', (t) => {
  t.after(cleanup);
  assert.equal(detectFramework(ws({ 'package.json': JSON.stringify({ devDependencies: { vite: '5' } }) })), 'vite');
  assert.equal(detectFramework(ws({ 'package.json': JSON.stringify({ dependencies: { astro: '4' } }) })), 'astro');
  assert.equal(detectFramework(ws({ 'index.html': 'x' })), null, 'null means static, which is a real answer');
  assert.equal(projectNameFor('C:/Projects/My App (v2)'), 'my-app-v2');
  // ⚠️ Vercel rejects a name containing `---`, and a run of dashes survives the
  // character filter because `-` is legal — so it needs its own collapse.
  assert.equal(projectNameFor('/x/a-----b'), 'a--b');
  assert.equal(projectNameFor('/tmp/---'), 'acuvo-preview');
  assert.ok(projectNameFor(`/x/${'a'.repeat(300)}`).length <= 100);
});

// ── scope: whose account, and which project ────────────────────────────────

test('⭐⭐ A LINKED WORKSPACE DEPLOYS TO THE PROJECT THE USER ALREADY HAS', async (t) => {
  t.after(cleanup);
  const root = ws({
    'index.html': 'x',
    '.vercel/project.json': JSON.stringify({ projectId: 'prj_JNYDrhX74O3XyqGUxC6IRMFj8Wwm', orgId: 'team_abc' }),
  });
  assert.deepEqual(readLinkedProject(root), { projectId: 'prj_JNYDrhX74O3XyqGUxC6IRMFj8Wwm', orgId: 'team_abc' });
  assert.equal(teamIdFor(root, { env: {} }), 'team_abc');

  const fetchImpl = fakeVercel();
  const r = await deployPreview(root, { env: ON, fetchImpl, acknowledgeBuildCost: true, sleepImpl: noSleep });
  assert.equal(r.ok, true, r.error);
  const create = fetchImpl.calls.find((c) => c.url.includes('/v13/deployments?'));
  assert.equal(JSON.parse(create.body).project, 'prj_JNYDrhX74O3XyqGUxC6IRMFj8Wwm',
    'without this the preview lands in a NEW project with none of the user\'s env vars');
  // ⚠️ the team scope must ride on EVERY call, not only the create.
  assert.ok(fetchImpl.calls.every((c) => c.url.includes('teamId=team_abc')), fetchImpl.calls.map((c) => c.url).join('\n'));
  // ⚠️ and `.vercel/` is read, never uploaded.
  assert.equal(r.fileCount, 1);
});

test('⚠️ a PERSONAL orgId is not a teamId — sending it would 403 every call', (t) => {
  t.after(cleanup);
  // Measured against the real API: a personal account stores a bare user id here.
  const root = ws({ '.vercel/project.json': JSON.stringify({ projectId: 'prj_1', orgId: 'HuEWmf1BucDyKkdJ7EtINcQm' }) });
  assert.equal(teamIdFor(root, { env: {} }), null);
  assert.equal(teamIdFor(root, { env: { VERCEL_TEAM_ID: 'team_env' } }), 'team_env', 'an explicit env var still wins');
});

test('naming a project explicitly overrides the link rather than being ignored', async (t) => {
  t.after(cleanup);
  const root = ws({ 'index.html': 'x', '.vercel/project.json': JSON.stringify({ projectId: 'prj_linked', orgId: null }) });
  const fetchImpl = fakeVercel();
  await deployPreview(root, { env: ON, fetchImpl, acknowledgeBuildCost: true, sleepImpl: noSleep, project: 'Scratch Pad' });
  const body = JSON.parse(fetchImpl.calls.find((c) => c.url.includes('/v13/deployments?')).body);
  assert.equal(body.project, 'scratch-pad');
  assert.equal(body.name, 'scratch-pad');
});

// ── the wire ───────────────────────────────────────────────────────────────

test('every file is uploaded with its digest in the header', async () => {
  const fetchImpl = recorder(() => resp(200, { urls: [] }));
  const files = [
    { file: 'a.js', sha: 'aaa', size: 3, data: Buffer.from('abc') },
    { file: 'b.js', sha: 'bbb', size: 2, data: Buffer.from('de') },
  ];
  const r = await uploadFiles(files, { token: 't', fetchImpl, concurrency: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.uploaded, 2);
  assert.deepEqual(fetchImpl.calls.map((c) => c.headers['x-vercel-digest']).sort(), ['aaa', 'bbb']);
  assert.equal(fetchImpl.calls[0].headers['content-length'], '3');
  assert.ok(fetchImpl.calls.every((c) => c.url.endsWith('/v2/files') && c.method === 'POST'));
});

test('one failed upload aborts the rest — a partial upload only buys a missing_files rejection', async () => {
  const fetchImpl = recorder((url, init, n) => (n === 1 ? resp(500, { error: { code: 'x', message: 'boom' } }) : resp(200, {})));
  const files = Array.from({ length: 6 }, (_, i) => ({ file: `f${i}`, sha: `s${i}`, size: 1, data: Buffer.from('x') }));
  const r = await uploadFiles(files, { token: 't', fetchImpl, concurrency: 1 });
  assert.equal(r.ok, false);
  assert.match(r.error, /uploading f0/);
  assert.ok(fetchImpl.calls.length < 6, `stopped after ${fetchImpl.calls.length} instead of 6`);
});

test('missing_files is explained as the retryable race it is', async () => {
  const fetchImpl = recorder(() => resp(400, { error: { code: 'missing_files', message: 'Missing files', missing: ['a', 'b'] } }));
  const r = await createPreviewDeployment({ token: 't', project: 'p', files: [{ file: 'a', sha: 's', size: 1 }], fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.error, /Retry/);
});

test('the poll reads `status` as well as `readyState` — older and newer deployments disagree', async () => {
  const seq = [
    resp(200, { id: 'd', readyState: 'BUILDING' }),
    resp(200, { id: 'd', status: 'READY', url: 'p-abc.vercel.app' }),
  ];
  const fetchImpl = recorder((u, i, n) => seq[n - 1]);
  const r = await pollDeployment('d', { token: 't', fetchImpl, sleepImpl: noSleep });
  assert.equal(r.ok, true);
  assert.equal(r.readyState, 'READY');
  assert.equal(r.url, 'https://p-abc.vercel.app');
});

test('a poll that runs out of patience is still building, not failed', async () => {
  const fetchImpl = recorder(() => resp(200, { id: 'd', readyState: 'BUILDING', inspectorUrl: 'https://vercel.com/i' }));
  let clock = 0;
  const r = await pollDeployment('d', {
    token: 't', fetchImpl, sleepImpl: async () => { clock += 4_000; }, nowImpl: () => clock, timeout: 10_000,
  });
  assert.equal(r.ok, true);
  assert.equal(r.timedOut, true);
  assert.equal(r.readyState, 'BUILDING');
});

test('build logs come back oldest-first, and errorsOnly really filters', async () => {
  const events = [
    { type: 'stderr', text: 'Module not found: ./uilts' },
    { type: 'stdout', payload: { text: 'installing' } },
    { type: 'command', text: 'npm run build' },
  ];
  const fetchImpl = recorder(() => resp(200, events));
  const all = await getBuildLogs('dpl_1', { token: 't', fetchImpl });
  assert.deepEqual(all.lines.map((l) => l.text), ['npm run build', 'installing', 'Module not found: ./uilts']);
  assert.match(fetchImpl.calls[0].url, /direction=backward/);
  assert.match(fetchImpl.calls[0].url, /builds=1/);

  const only = await getBuildLogs('dpl_1', { token: 't', fetchImpl, errorsOnly: true });
  assert.deepEqual(only.lines.map((l) => l.text), ['Module not found: ./uilts']);
});

// ── end to end, against a fake Vercel ───────────────────────────────────────

/** A fake Vercel that accepts uploads, builds, and finishes in the given state. */
function fakeVercel({ finalState = 'READY', logs = [] } = {}) {
  return recorder((url) => {
    // ⚠️ `includes`, not `endsWith` — every path may carry `?teamId=`.
    if (url.includes('/v2/files')) return resp(200, { urls: [] });
    if (url.includes('/v13/deployments?')) {
      return resp(200, { id: 'dpl_ok', url: 'my-app-abc123.vercel.app', inspectorUrl: 'https://vercel.com/x/my-app/abc123', readyState: 'QUEUED' });
    }
    if (url.includes('/events')) return resp(200, logs);
    if (url.includes('/v13/deployments/')) {
      return resp(200, { id: 'dpl_ok', readyState: finalState, url: 'my-app-abc123.vercel.app', inspectorUrl: 'https://vercel.com/x/my-app/abc123', errorMessage: finalState === 'ERROR' ? 'Command "npm run build" exited with 1' : null });
    }
    throw new Error(`unexpected call: ${url}`);
  });
}

test('⭐⭐⭐ CODE ON DISK → A PREVIEW URL', async (t) => {
  t.after(cleanup);
  const root = ws({ 'index.html': '<h1>hi</h1>', 'package.json': JSON.stringify({ dependencies: { next: '15' } }), '.env': 'K=v' });
  const fetchImpl = fakeVercel();
  const states = [];
  const r = await deployPreview(root, {
    env: ON, fetchImpl, acknowledgeBuildCost: true, sleepImpl: noSleep, onState: (s) => states.push(s),
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.url, 'https://my-app-abc123.vercel.app');
  assert.equal(r.target, 'preview');
  assert.equal(r.buildsSpent, 1);
  assert.equal(r.fileCount, 2, 'the .env was withheld');
  assert.deepEqual(r.skippedSecrets, ['.env']);
  assert.equal(r.inspectorUrl, 'https://vercel.com/x/my-app/abc123');
  assert.deepEqual(states, ['READY']);

  // ⚠️ EXACTLY ONE BUILD. Two POSTs to /v13/deployments would be two bills.
  const creates = fetchImpl.calls.filter((c) => c.url.includes('/v13/deployments?'));
  assert.equal(creates.length, 1);
  assert.equal('target' in JSON.parse(creates[0].body), false);
});

test('⭐⭐ A FAILED BUILD COMES BACK WITH ITS LOG, NOT JUST "failed"', async (t) => {
  t.after(cleanup);
  const root = ws({ 'index.html': 'x' });
  const fetchImpl = fakeVercel({
    finalState: 'ERROR',
    logs: [{ type: 'stderr', text: "Module not found: Can't resolve './uilts'" }, { type: 'command', text: 'npm run build' }],
  });
  const r = await deployPreview(root, { env: ON, fetchImpl, acknowledgeBuildCost: true, sleepImpl: noSleep });
  assert.equal(r.ok, false);
  assert.match(r.error, /ERROR/);
  assert.match(r.error, /exited with 1/);
  assert.equal(r.buildsSpent, 1, 'the money is spent whether or not it worked, and the report must say so');
  assert.equal(r.logs.length, 2);
  assert.match(r.logs.map((l) => l.text).join('\n'), /uilts/);
  assert.equal(r.inspectorUrl, 'https://vercel.com/x/my-app/abc123');
});

test('no credentials is a sentence a person can act on, and costs no build', async (t) => {
  t.after(cleanup);
  const root = ws({ 'index.html': 'x' });
  const fetchImpl = recorder(() => resp(200, {}));
  const r = await deployPreview(root, {
    env: { [ALLOW_DEPLOY_ENV]: '1' }, fetchImpl, acknowledgeBuildCost: true,
    readFileImpl: () => { throw new Error('ENOENT'); }, homeImpl: () => '/nowhere',
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /vercel login/);
  assert.equal(fetchImpl.calls.length, 0);
});

test('the Vercel CLI login is reused rather than demanding a second token', () => {
  const seen = [];
  const readFileImpl = (p) => {
    seen.push(String(p));
    if (String(p).includes('com.vercel.cli')) return JSON.stringify({ token: 'from_cli' });
    throw new Error('ENOENT');
  };
  const r = findToken({ env: {}, readFileImpl, homeImpl: () => join('/', 'home', 'roman') });
  assert.equal(r.ok, true);
  assert.equal(r.token, 'from_cli');
  assert.match(r.source, /Vercel CLI/);
  assert.equal(findToken({ env: { VERCEL_TOKEN: ' env_wins ' }, readFileImpl }).token, 'env_wins');
});

test('status and logs need an id, and say so instead of guessing', async (t) => {
  t.after(cleanup);
  const root = ws({ 'index.html': 'x' });
  for (const action of ['status', 'logs']) {
    const r = await executeVercel(root, { action }, { env: ON, fetchImpl: EXPLODE });
    assert.equal(r.ok, false);
    assert.match(r.error, /needs the deployment id/);
  }
  const fetchImpl = recorder(() => resp(200, { id: 'dpl_1', readyState: 'READY', url: 'a.vercel.app', target: null }));
  const s = await executeVercel(root, { action: 'status', id: 'dpl_1' }, { env: ON, fetchImpl });
  assert.equal(s.ok, true);
  assert.equal(s.url, 'https://a.vercel.app');
});

// ── the offer describes the tool that exists ───────────────────────────────

/* ────────────────────────────────────────────────────────────────────────────
 * ⭐⭐⭐ REACH — through the REAL registry and the REAL dispatcher.
 *
 * ⚠️ This repo has shipped built-but-unreached capability four times in one day
 * and written it down (`feedback_only_the_end_to_end_run_proves_reach`). Testing
 * `executeVercel` directly proves the module; only `executeToolCall` proves the
 * model can actually get to it.
 * ────────────────────────────────────────────────────────────────────────── */

test('⭐⭐⭐ THE REGISTRY OFFERS IT — but only when the operator turned it on', () => {
  const off = toolNamesForRounds(40, { allowRun: true, root: process.cwd(), env: { ...process.env, [ALLOW_DEPLOY_ENV]: '' } });
  assert.equal(off.includes(VERCEL_TOOL_NAME), false);
  const on = toolNamesForRounds(40, { allowRun: true, root: process.cwd(), env: { ...process.env, [ALLOW_DEPLOY_ENV]: '1' } });
  assert.equal(on.includes(VERCEL_TOOL_NAME), true, 'a verb nobody is offered is a verb nobody has');
  const noRun = toolNamesForRounds(40, { allowRun: false, root: process.cwd(), env: { ...process.env, [ALLOW_DEPLOY_ENV]: '1' } });
  assert.equal(noRun.includes(VERCEL_TOOL_NAME), false, '--no-run must withhold the one verb that spends money');

  // ⚠️ And the schema really is in the registry the offer serialises from.
  assert.ok(TOOL_SCHEMAS.some((s) => s.function?.name === VERCEL_TOOL_NAME));
  assert.ok(TOOL_NAMES.includes(VERCEL_TOOL_NAME));
});

test('⭐⭐⭐ THE DISPATCHER REACHES THE MODULE, AND THE GATE HOLDS THERE TOO', async (t) => {
  t.after(cleanup);
  const root = ws({ 'index.html': '<h1>hi</h1>' });
  const executor = { root, dryRun: false };
  const call = (args, allowRun = true) => executeToolCall(
    { id: 'c', function: { name: VERCEL_TOOL_NAME, arguments: JSON.stringify(args) } },
    executor,
    { allowRun },
  );

  const before = process.env[ALLOW_DEPLOY_ENV];
  try {
    // ── OFF: the gate the dispatcher consults is the module's, not the offer's.
    delete process.env[ALLOW_DEPLOY_ENV];
    const refused = await call({ action: 'plan' });
    assert.equal(refused.result.ok, false);
    assert.match(refused.result.error, /ACUVO_ALLOW_DEPLOY/);
    assert.equal(refused.mutated, false, 'a deployment changes Vercel, never a path in this workspace');

    // ── ON: the free plan flows all the way back through the real dispatcher.
    process.env[ALLOW_DEPLOY_ENV] = '1';
    const planned = await call({ action: 'plan' });
    assert.equal(planned.result.ok, true, planned.result.error);
    assert.equal(planned.result.fileCount, 1);
    assert.match(planned.result.cost, /1 Vercel BUILD/);

    // ── --no-run: withheld at the dispatcher as well as at the offer.
    const held = await call({ action: 'deploy', acknowledgeBuildCost: true }, false);
    assert.equal(held.result.ok, false);
    assert.match(held.result.error, /--no-run/);

    // ⚠️ And a deploy through the dispatcher with no acknowledgement still
    // costs nothing — it cannot reach the network before the second gate.
    const unacked = await call({ action: 'deploy' });
    assert.equal(unacked.result.ok, false);
    assert.match(unacked.result.error, /acknowledged/);
  } finally {
    if (before === undefined) delete process.env[ALLOW_DEPLOY_ENV];
    else process.env[ALLOW_DEPLOY_ENV] = before;
  }
});

test('the schema advertises the two-step shape and cannot advertise production', () => {
  const [schema] = vercelToolSchemas();
  assert.equal(schema.function.name, VERCEL_TOOL_NAME);
  const props = schema.function.parameters.properties;
  assert.deepEqual(props.action.enum, ['plan', 'deploy', 'status', 'logs']);
  assert.equal('target' in props, false, 'a parameter that does not exist cannot be got wrong');
  assert.match(schema.function.description, /PREVIEW/);
  assert.match(schema.function.description, /PAID BUILD/);
  assert.match(schema.function.description, /acknowledgeBuildCost/);
});
