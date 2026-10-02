/**
 * ── pipe_to_asset — GENERATE THE ASSET *AND* WRITE THE CODE THAT USES IT ────
 *
 * ⚠️⚠️ NOTHING IN THIS FILE DRAWS AN IMAGE. Every test injects a `producer`
 * that writes a fixture byte-string to disk and records the call. That is not a
 * convenience — a suite that really generated would cost GPU seconds per run,
 * take a minute per case, and be at the mercy of a free provider measured
 * throttling from 2.6s to 45s inside one run.
 *
 * ⭐ AND THE MOCK IS AIMED AT THE RIGHT SEAM. `imagegen.mjs` is already tested
 * against its providers; what has never been tested is the thing this verb adds
 * — the FILE LANDING WHERE THE PROJECT WANTS IT and the CODE EDIT that points
 * at it. So every assertion here is about a byte on disk or a character in a
 * source file, never about a picture.
 *
 * ⭐ `calls` IS ASSERTED IN THE REFUSAL CASES, and it is the most important
 * assertion in the file. The whole design claim is "the cheap half can refuse,
 * so it runs first" — an ambiguity that refuses AFTER a render has cost real
 * money and the test would still be green without counting.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  pipeToAsset, pipeAssetToolSchemas, pipeAssetToolNames, runPipeAssetTool,
  splitAssetTarget, resolveReference, extensionOf,
  PIPE_ASSET_TOOL_NAMES,
} from '../lib/pipe-asset.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';
import { TOOL_NAMES, TOOL_SCHEMAS, toolNamesForRounds, executeToolCall } from '../lib/tools.mjs';
import { REFUSED_TOOL_REASONS } from '../lib/mcp-server.mjs';

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-pipe-asset-'));
  t.after(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* windows handle lag */ } });
  return root;
}

/**
 * A stand-in for `generateImage`. It behaves the way the real one does in the
 * two respects this verb depends on: it writes into the workspace ROOT under a
 * name derived from the prompt, and IT CHOOSES THE EXTENSION.
 */
function fakeProducer(root, { ext = '.jpg', ok = true, error = 'the engine refused', extra = {} } = {}) {
  const state = { calls: [] };
  const producer = async (args) => {
    state.calls.push(args);
    if (!ok) return { ok: false, error };
    const name = `generated${ext}`;
    writeFileSync(join(root, name), Buffer.from('not-really-an-image'));
    return { ok: true, path: name, bytes: 19, provider: 'fake-engine', ...extra };
  };
  return { producer, state };
}

const HTML = '<main>\n  <img src="__HERO__" alt="hero">\n</main>\n';

/* ════════════════════════════════════════════════════════════════════════════
 * 1. THE HAPPY PATH — a file on disk and a reference that points at it
 * ════════════════════════════════════════════════════════════════════════════ */

test('⭐⭐ it writes the asset where the project wants it AND edits the code that references it', async (t) => {
  const root = workspace(t);
  mkdirSync(join(root, 'public'), { recursive: true });
  writeFileSync(join(root, 'public', 'index.html'), HTML);
  const { producer, state } = fakeProducer(root, { ext: '.jpg' });

  const r = await pipeToAsset(createLocalExecutor(root), {
    prompt: 'a wide cinematic photograph of a lighthouse at dusk',
    asset_path: 'public/img/hero.png',
    code_path: 'public/index.html',
    placeholder: '__HERO__',
  }, { producer, env: {} });

  assert.equal(r.ok, true, r.error);
  assert.equal(state.calls.length, 1, 'exactly one render');

  // The asset really moved out of the generator's root drop and into the project.
  assert.equal(existsSync(join(root, 'public', 'img', 'hero.jpg')), true, 'the asset is not where it was asked for');
  assert.equal(existsSync(join(root, 'generated.jpg')), false, 'the generator drop was left behind');

  // …and the code really points at it.
  const after = readFileSync(join(root, 'public', 'index.html'), 'utf8');
  assert.equal(after, '<main>\n  <img src="img/hero.jpg" alt="hero">\n</main>\n');
  assert.equal(r.assetPath, 'public/img/hero.jpg');
  assert.equal(r.reference, 'img/hero.jpg');
  assert.equal(r.referenceStyle, 'relative');
  assert.equal(r.generated, true);
  assert.equal(r.edited, true);
});

/**
 * ── ⭐⭐ THE DEFECT THIS VERB EXISTS TO CLOSE ────────────────────────────────
 *
 * `imagegen.mjs`'s own schema: *"the extension follows whatever the engine
 * returns, so use the exact path from the result rather than assuming one."*
 * The caller asked for `.png` and the engine returned JPEG — which is what the
 * free fallback does, on every install with no GPU secret. A model doing this by
 * hand writes `hero.png` into the markup and the page silently loads nothing.
 */
test('⭐⭐ the caller asks for .png, the engine returns .jpg, and the CODE says .jpg', async (t) => {
  const root = workspace(t);
  writeFileSync(join(root, 'index.html'), '<img src="HERO">\n');
  const { producer } = fakeProducer(root, { ext: '.jpg' });

  const r = await pipeToAsset(createLocalExecutor(root), {
    prompt: 'hero', asset_path: 'assets/hero.png', code_path: 'index.html', placeholder: 'HERO',
  }, { producer, env: {} });

  assert.equal(r.ok, true, r.error);
  assert.equal(r.assetPath, 'assets/hero.jpg', 'the guessed extension was not replaced');
  assert.equal(existsSync(join(root, 'assets', 'hero.jpg')), true);
  assert.equal(existsSync(join(root, 'assets', 'hero.png')), false, 'a .png full of JPEG reached the disk');
  assert.equal(readFileSync(join(root, 'index.html'), 'utf8'), '<img src="assets/hero.jpg">\n');
});

test('the reference is relative to the FILE being edited, not to the workspace root', async (t) => {
  const root = workspace(t);
  mkdirSync(join(root, 'src', 'components'), { recursive: true });
  writeFileSync(join(root, 'src', 'components', 'Hero.jsx'), 'const src = "SLOT";\n');
  const { producer } = fakeProducer(root, { ext: '.png' });

  const r = await pipeToAsset(createLocalExecutor(root), {
    prompt: 'hero', asset_path: 'src/assets/hero', code_path: 'src/components/Hero.jsx', placeholder: 'SLOT',
  }, { producer, env: {} });

  assert.equal(r.ok, true, r.error);
  assert.equal(r.reference, '../assets/hero.png');
  assert.equal(readFileSync(join(root, 'src', 'components', 'Hero.jsx'), 'utf8'), 'const src = "../assets/hero.png";\n');
});

/**
 * ⭐ `{file}` IS WHY THE OVERRIDE IS USABLE AT ALL. A project that serves a
 * directory at a URL root needs `/img/hero.jpg` — and the caller cannot type
 * that, because the extension is the one thing they do not know yet.
 */
test('⭐ `reference` overrides the path, and {file} fills in the extension the caller could not know', async (t) => {
  const root = workspace(t);
  mkdirSync(join(root, 'app'), { recursive: true });
  writeFileSync(join(root, 'app', 'page.tsx'), 'src={"SLOT"}\n');
  const { producer } = fakeProducer(root, { ext: '.jpg' });

  const r = await pipeToAsset(createLocalExecutor(root), {
    prompt: 'hero', asset_path: 'public/img/hero', code_path: 'app/page.tsx',
    placeholder: 'SLOT', reference: '/img/{file}',
  }, { producer, env: {} });

  assert.equal(r.ok, true, r.error);
  assert.equal(r.reference, '/img/hero.jpg');
  assert.equal(r.referenceStyle, 'given');
  assert.equal(readFileSync(join(root, 'app', 'page.tsx'), 'utf8'), 'src={"/img/hero.jpg"}\n');
});

test('a directory destination derives the filename from the prompt', async (t) => {
  const root = workspace(t);
  mkdirSync(join(root, 'static'), { recursive: true });
  writeFileSync(join(root, 'index.html'), '<img src="SLOT">\n');
  const { producer } = fakeProducer(root, { ext: '.png' });

  // "static" exists as a directory, so it is treated as one even with no slash.
  const r = await pipeToAsset(createLocalExecutor(root), {
    prompt: 'A calm harbour at dawn', asset_path: 'static', code_path: 'index.html', placeholder: 'SLOT',
  }, { producer, env: {} });

  assert.equal(r.ok, true, r.error);
  assert.equal(r.assetPath, 'static/a-calm-harbour-at-dawn.png');
  assert.equal(existsSync(join(root, 'static', 'a-calm-harbour-at-dawn.png')), true);
  assert.equal(existsSync(join(root, 'static.png')), false, 'a directory name became a file name');
});

/* ════════════════════════════════════════════════════════════════════════════
 * 2. AMBIGUITY — REFUSED, NEVER ASKED, AND BEFORE A SINGLE GPU SECOND
 * ════════════════════════════════════════════════════════════════════════════ */

test('⭐⭐ a placeholder that appears TWICE is refused, and NOTHING is generated', async (t) => {
  const root = workspace(t);
  writeFileSync(join(root, 'index.html'), '<img src="SLOT">\n<img src="SLOT">\n');
  const { producer, state } = fakeProducer(root);

  const r = await pipeToAsset(createLocalExecutor(root), {
    prompt: 'hero', asset_path: 'assets/hero.png', code_path: 'index.html', placeholder: 'SLOT',
  }, { producer, env: {} });

  assert.equal(r.ok, false);
  assert.equal(state.calls.length, 0, 'the render happened before the refusal — that is real money on an argument');
  assert.equal(r.generated, false);
  assert.match(r.error, /appears 2 times/, 'the count from applyEdit did not survive');
  assert.match(r.error, /Nothing was generated/);
  // The refusal must hand the decision back, not ask for it.
  assert.match(r.error, /never asks/);
  assert.equal(readFileSync(join(root, 'index.html'), 'utf8'), '<img src="SLOT">\n<img src="SLOT">\n');
});

test('⭐ a placeholder that is ABSENT is refused, and nothing is generated', async (t) => {
  const root = workspace(t);
  writeFileSync(join(root, 'index.html'), '<img src="something-else">\n');
  const { producer, state } = fakeProducer(root);

  const r = await pipeToAsset(createLocalExecutor(root), {
    prompt: 'hero', asset_path: 'assets/hero.png', code_path: 'index.html', placeholder: 'SLOT',
  }, { producer, env: {} });

  assert.equal(r.ok, false);
  assert.equal(state.calls.length, 0);
  assert.match(r.error, /was not found/);
});

test('⭐ a code file that does not exist is refused before the render', async (t) => {
  const root = workspace(t);
  const { producer, state } = fakeProducer(root);

  const r = await pipeToAsset(createLocalExecutor(root), {
    prompt: 'hero', asset_path: 'assets/hero.png', code_path: 'nope.html', placeholder: 'SLOT',
  }, { producer, env: {} });

  assert.equal(r.ok, false);
  assert.equal(state.calls.length, 0);
  assert.match(r.error, /no such file/);
  assert.match(r.error, /nothing was generated/i);
});

test('⭐ an asset_path that escapes the workspace is refused before the render', async (t) => {
  const root = workspace(t);
  writeFileSync(join(root, 'index.html'), '<img src="SLOT">\n');
  const { producer, state } = fakeProducer(root);

  for (const bad of ['../evil.png', '/etc/passwd.png', 'C:/windows/x.png']) {
    const r = await pipeToAsset(createLocalExecutor(root), {
      prompt: 'hero', asset_path: bad, code_path: 'index.html', placeholder: 'SLOT',
    }, { producer, env: {} });
    assert.equal(r.ok, false, `${bad} was accepted`);
    assert.match(r.error, /asset_path is refused/);
  }
  assert.equal(state.calls.length, 0, 'a refused destination still bought a render');
});

test('the required arguments are named, and each refusal says which one', async (t) => {
  const root = workspace(t);
  writeFileSync(join(root, 'index.html'), '<img src="SLOT">\n');
  const { producer, state } = fakeProducer(root);
  const base = { prompt: 'hero', asset_path: 'a.png', code_path: 'index.html', placeholder: 'SLOT' };

  for (const [key, pattern] of [['prompt', /prompt is required/], ['placeholder', /placeholder is required/], ['asset_path', /asset_path is required/]]) {
    const args = { ...base, [key]: '' };
    const r = await pipeToAsset(createLocalExecutor(root), args, { producer, env: {} });
    assert.equal(r.ok, false, `a missing ${key} was accepted`);
    assert.match(r.error, pattern);
  }
  assert.equal(state.calls.length, 0);
});

/* ════════════════════════════════════════════════════════════════════════════
 * 3. WHEN A HALF FAILS — no dangling reference, no lost asset
 * ════════════════════════════════════════════════════════════════════════════ */

test('⭐⭐ a failed render leaves the code UNTOUCHED — never a reference to a file that was not drawn', async (t) => {
  const root = workspace(t);
  writeFileSync(join(root, 'index.html'), HTML);
  const { producer } = fakeProducer(root, { ok: false, error: 'both image providers failed' });

  const r = await pipeToAsset(createLocalExecutor(root), {
    prompt: 'hero', asset_path: 'assets/hero.png', code_path: 'index.html', placeholder: '__HERO__',
  }, { producer, env: {} });

  assert.equal(r.ok, false);
  assert.equal(r.edited, false);
  assert.match(r.error, /both image providers failed/);
  assert.match(r.error, /left unchanged/);
  assert.equal(readFileSync(join(root, 'index.html'), 'utf8'), HTML, 'a broken page was shipped as a wiring');
});

test('⭐ a destination that already exists is refused, the asset is kept, and the code is untouched', async (t) => {
  const root = workspace(t);
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'assets', 'hero.jpg'), 'the one that was already there');
  writeFileSync(join(root, 'index.html'), HTML);
  const { producer } = fakeProducer(root, { ext: '.jpg' });

  const r = await pipeToAsset(createLocalExecutor(root), {
    prompt: 'hero', asset_path: 'assets/hero.png', code_path: 'index.html', placeholder: '__HERO__',
  }, { producer, env: {} });

  assert.equal(r.ok, false);
  assert.equal(r.generated, true, 'the render really happened and must be reported');
  assert.equal(r.assetPath, 'generated.jpg', 'the caller has to be told where the asset actually is');
  assert.equal(readFileSync(join(root, 'assets', 'hero.jpg'), 'utf8'), 'the one that was already there');
  assert.equal(readFileSync(join(root, 'index.html'), 'utf8'), HTML);
  assert.match(r.error, /already exists/);
});

test('…and `overwrite: true` is how the caller says they meant it', async (t) => {
  const root = workspace(t);
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'assets', 'hero.jpg'), 'stale');
  writeFileSync(join(root, 'index.html'), HTML);
  const { producer } = fakeProducer(root, { ext: '.jpg' });

  const r = await pipeToAsset(createLocalExecutor(root), {
    prompt: 'hero', asset_path: 'assets/hero.png', code_path: 'index.html', placeholder: '__HERO__', overwrite: true,
  }, { producer, env: {} });

  assert.equal(r.ok, true, r.error);
  assert.equal(readFileSync(join(root, 'assets', 'hero.jpg'), 'utf8'), 'not-really-an-image');
});

/**
 * ⚠️ A SUCCESS WITH NO EDIT IS STILL A SUCCESS. `applyEdit` refuses an edit
 * whose two sides are identical — correct in general, and it would report a run
 * where absolutely everything worked as a failure.
 */
test('a placeholder that is ALREADY the right reference reports success with no edit', async (t) => {
  const root = workspace(t);
  writeFileSync(join(root, 'index.html'), '<img src="assets/hero.jpg">\n');
  const { producer } = fakeProducer(root, { ext: '.jpg' });

  const r = await pipeToAsset(createLocalExecutor(root), {
    prompt: 'hero', asset_path: 'assets/hero.jpg', code_path: 'index.html', placeholder: 'assets/hero.jpg',
  }, { producer, env: {} });

  assert.equal(r.ok, true, r.error);
  assert.equal(r.generated, true);
  assert.equal(r.edited, false);
  assert.match(r.note, /already references it/);
  assert.equal(existsSync(join(root, 'assets', 'hero.jpg')), true);
});

/* ════════════════════════════════════════════════════════════════════════════
 * 4. THE PROPERTIES INHERITED FROM THE ENGINES IT WRAPS
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * ⭐ CRLF IS THE REASON `editThroughExecutor` IS IMPORTED RATHER THAN A LOCAL
 * read/replace/write. `edit.mjs`'s header calls a whole-file rewrite on a
 * Windows file "a funnel into the hazard": the bytes outside the replaced span
 * must be identical, endings included.
 */
test('⭐ a CRLF file keeps its CRLF endings — the edit engine is imported, not re-written', async (t) => {
  const root = workspace(t);
  writeFileSync(join(root, 'index.html'), '<main>\r\n  <img src="SLOT">\r\n</main>\r\n');
  const { producer } = fakeProducer(root, { ext: '.png' });

  const r = await pipeToAsset(createLocalExecutor(root), {
    prompt: 'hero', asset_path: 'assets/hero.png', code_path: 'index.html', placeholder: 'SLOT',
  }, { producer, env: {} });

  assert.equal(r.ok, true, r.error);
  const after = readFileSync(join(root, 'index.html'), 'utf8');
  assert.equal(after, '<main>\r\n  <img src="assets/hero.png">\r\n</main>\r\n');
});

test('the critic verdict and the engine name survive the wrapper', async (t) => {
  const root = workspace(t);
  writeFileSync(join(root, 'index.html'), '<img src="SLOT">\n');
  const { producer } = fakeProducer(root, {
    ext: '.png',
    extra: { note: 'Drawn by Pollinations. Reviewed and NOT accepted (3/10).', accepted: false, score: 3 },
  });

  const r = await pipeToAsset(createLocalExecutor(root), {
    prompt: 'hero', asset_path: 'assets/hero.png', code_path: 'index.html', placeholder: 'SLOT',
  }, { producer, env: {} });

  assert.equal(r.ok, true, r.error);
  assert.match(r.imageNote, /NOT accepted/, 'a wrapper that swallows the critic makes the image look better than it is');
  assert.equal(r.accepted, false);
  assert.equal(r.provider, 'fake-engine');
});

/* ════════════════════════════════════════════════════════════════════════════
 * 5. --dry-run — THE FLAG THAT PROMISES NOTHING IS WRITTEN, AND NOTHING IS BILLED
 * ════════════════════════════════════════════════════════════════════════════ */

test('⭐⭐ a dry run generates NOTHING, writes NOTHING, and still reports the plan', async (t) => {
  const root = workspace(t);
  writeFileSync(join(root, 'index.html'), HTML);
  const { producer, state } = fakeProducer(root);

  const r = await pipeToAsset(createLocalExecutor(root, { dryRun: true }), {
    prompt: 'hero', asset_path: 'assets/hero.png', code_path: 'index.html', placeholder: '__HERO__',
  }, { producer, env: {} });

  assert.equal(r.ok, true, r.error);
  assert.equal(r.dryRun, true);
  assert.equal(r.generated, false);
  assert.equal(r.edited, false);
  assert.equal(state.calls.length, 0, 'a dry run rendered an image — that is a bill the flag promised not to send');
  assert.equal(readFileSync(join(root, 'index.html'), 'utf8'), HTML);
  assert.equal(existsSync(join(root, 'assets')), false);
  assert.match(r.note, /Would generate/);
});

test('⚠️ a dry run still applies every refusal a real run would', async (t) => {
  const root = workspace(t);
  writeFileSync(join(root, 'index.html'), '<img src="SLOT">\n<img src="SLOT">\n');
  const { producer } = fakeProducer(root);

  const r = await pipeToAsset(createLocalExecutor(root, { dryRun: true }), {
    prompt: 'hero', asset_path: 'assets/hero.png', code_path: 'index.html', placeholder: 'SLOT',
  }, { producer, env: {} });

  assert.equal(r.ok, false, 'a preview that skips validation is a preview of a different command');
  assert.match(r.error, /appears 2 times/);
});

/* ════════════════════════════════════════════════════════════════════════════
 * 6. THE PURE HELPERS
 * ════════════════════════════════════════════════════════════════════════════ */

test('splitAssetTarget: directory forms, guessed extensions, and stems that only look like one', () => {
  const dir = () => false;
  assert.deepEqual(splitAssetTarget('public/img/hero.png', 'a hero', dir), { ok: true, dir: 'public/img', stem: 'hero' });
  assert.deepEqual(splitAssetTarget('public/img/', 'A Hero Shot', dir), { ok: true, dir: 'public/img', stem: 'a-hero-shot' });
  assert.deepEqual(splitAssetTarget('hero', 'x', dir), { ok: true, dir: '', stem: 'hero' });
  // ⚠️ `.v2` is not an image extension, so it is part of the NAME. `extname`
  // would have called it a suffix and silently renamed the caller's file.
  assert.deepEqual(splitAssetTarget('img/hero.v2', 'x', dir), { ok: true, dir: 'img', stem: 'hero.v2' });
  // A path that IS a directory on disk is treated as one even with no slash.
  assert.deepEqual(splitAssetTarget('static', 'Sunset Ridge', (p) => p === 'static'), { ok: true, dir: 'static', stem: 'sunset-ridge' });
  assert.equal(splitAssetTarget('', 'x', dir).ok, false);
  // Backslashes are unified, the way every other path in this package is.
  assert.deepEqual(splitAssetTarget('img\\hero.jpg', 'x', dir), { ok: true, dir: 'img', stem: 'hero' });
});

test('extensionOf follows the produced file, and falls back rather than producing a bare name', () => {
  assert.equal(extensionOf('generated.jpg'), '.jpg');
  assert.equal(extensionOf('a/b/hero.PNG'), '.png');
  assert.equal(extensionOf('noextension'), '.png');
  assert.equal(extensionOf('trailing.'), '.png');
  assert.equal(extensionOf('.hidden'), '.png');
});

test('resolveReference: relative by default, verbatim when given, tokens filled', () => {
  assert.equal(resolveReference('index.html', 'assets/hero.jpg').text, 'assets/hero.jpg');
  assert.equal(resolveReference('public/index.html', 'public/img/hero.jpg').text, 'img/hero.jpg');
  assert.equal(resolveReference('src/components/Hero.jsx', 'src/assets/hero.jpg').text, '../assets/hero.jpg');
  assert.equal(resolveReference('app/page.tsx', 'public/img/hero.jpg', '/img/{file}').text, '/img/hero.jpg');
  assert.equal(resolveReference('app/page.tsx', 'public/img/hero.jpg', 'ROOT/{path}').text, 'ROOT/public/img/hero.jpg');
  assert.equal(resolveReference('app/page.tsx', 'public/img/hero.jpg', '/fixed.svg').text, '/fixed.svg');
});

/* ════════════════════════════════════════════════════════════════════════════
 * 7. REACHABILITY — a capability nobody can call is not a capability
 * ════════════════════════════════════════════════════════════════════════════ */

test('⭐⭐ it is declared, dispatched and offered — and withheld where it could only refuse', (t) => {
  const root = workspace(t);
  writeFileSync(join(root, 'index.js'), 'x\n');

  assert.ok(TOOL_NAMES.includes('pipe_to_asset'), 'pipe_to_asset never reached TOOL_SCHEMAS');
  assert.deepEqual(pipeAssetToolSchemas().map((s) => s.function.name), [...PIPE_ASSET_TOOL_NAMES]);

  const multi = toolNamesForRounds(16, { root, env: {}, allowRun: true });
  assert.ok(multi.includes('pipe_to_asset'), 'a multi-round run is never offered the verb');

  const single = toolNamesForRounds(1, { root, env: {}, allowRun: true });
  assert.equal(single.includes('pipe_to_asset'), false, 'in a one-round run the file it edits has not been written yet');

  // The same switch that turns generate_image off must turn this off: without
  // an image chain it can only ever answer "no image service is set up".
  const off = toolNamesForRounds(16, { root, env: { PERCHANCE_IMAGE_URL: '' }, allowRun: true });
  assert.equal(off.includes('pipe_to_asset'), false);
  assert.deepEqual(pipeAssetToolNames({ PERCHANCE_IMAGE_URL: '' }, { maxRounds: 16 }), []);
  assert.deepEqual(pipeAssetToolNames({}, { maxRounds: 1 }), []);
});

/**
 * ⚠️ THROUGH `executeToolCall`, THE DOOR THE RUNTIME ACTUALLY OPENS — and in
 * DRY-RUN, because the dispatcher owns no producer seam and a real call here
 * would draw a real picture. The dry-run path proves the wiring end to end
 * (schema name → case label → module → result shape) for free.
 */
test('⭐ the dispatcher reaches it, and reports the ASSET as the mutated path', async (t) => {
  const root = workspace(t);
  writeFileSync(join(root, 'index.html'), HTML);
  const executor = createLocalExecutor(root, { dryRun: true });

  const rec = await executeToolCall({
    id: 'c1',
    function: {
      name: 'pipe_to_asset',
      arguments: JSON.stringify({
        prompt: 'a lighthouse', asset_path: 'public/img/hero.png', code_path: 'index.html', placeholder: '__HERO__',
      }),
    },
  }, executor);

  assert.notEqual(rec.result?.error, 'unknown tool: pipe_to_asset', 'declared but not dispatched');
  assert.equal(rec.result.ok, true, rec.result.error);
  assert.equal(rec.mutated, true, 'the run summary would not count the asset');
  assert.match(String(rec.mutatedPath), /public\/img\/hero/);
  assert.equal(readFileSync(join(root, 'index.html'), 'utf8'), HTML, 'a dry run wrote to disk');
});

test('runPipeAssetTool refuses a name that is not its own', async () => {
  const r = await runPipeAssetTool('something_else', {}, { executor: { root: '/nowhere' } });
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown pipe_to_asset tool/);
});

/**
 * ⚠️ THE MCP UNION GUARD. `mcp-server-surface.test.mjs` asserts
 * SERVED ∪ REFUSED === TOOL_NAMES, so a new tool that nobody classified turns
 * that file red. Asserted here too, next to the verb, so the reason a new
 * creative verb is refused over that transport lives beside the verb itself.
 */
test('⭐ it is refused over the MCP server transport, with a reason', () => {
  const why = REFUSED_TOOL_REASONS.pipe_to_asset;
  assert.equal(typeof why, 'string', 'unclassified — the SERVED ∪ REFUSED guard is now red');
  assert.ok(why.length > 30, why);
  assert.match(why, /generate_image/, 'the reason must point at the refusal it inherits');
});

test('the schema is small enough to ride on every multi-round turn', () => {
  const bytes = JSON.stringify(pipeAssetToolSchemas()).length;
  assert.ok(bytes < 2_600, `the pipe_to_asset schema is ${bytes} bytes — it is re-sent every round`);
  const schema = TOOL_SCHEMAS.find((s) => s.function.name === 'pipe_to_asset');
  assert.deepEqual(schema.function.parameters.required, ['prompt', 'asset_path', 'code_path', 'placeholder']);
  // The one warning the model must read on every call.
  assert.match(schema.function.description, /extension/);
});
