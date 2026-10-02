/**
 * `media_chain` — the CLI door onto the console's captions / dub / shorts chain.
 * Offline: the gateway is a stubbed fetch and the account comes from ACUVO_TOKEN,
 * so no real credential or network is ever touched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runMediaChainTool, mediaChainToolNames, mediaChainToolSchemas, formatMediaChainResult, mediaChainCeilingUsd,
} from '../lib/media-chain.mjs';
import { SPEND_APPROVAL_ARG } from '../lib/media-pipeline.mjs';
import { shortlistTools } from '../lib/tool-shortlist.mjs';

const EMPTY_HOME = mkdtempSync(join(tmpdir(), 'acuvo-mc-home-'));
const SIGNED = { ACUVO_TOKEN: 'xxi_test_token', ACUVO_GATEWAY_URL: 'https://gw.example/api/cli/v1/chat/completions' };

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-mc-'));
  mkdirSync(join(root, 'in'), { recursive: true });
  writeFileSync(join(root, 'in', 'talk.mp4'), Buffer.alloc(2048, 7));
  return root;
}

function gateway(reply) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith('https://signed.example/')) {
      return new Response(Buffer.alloc(4096, 1), { status: 200 });
    }
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, calls };
}

test('not offered without an account, never on a single-shot turn', () => {
  assert.deepEqual(mediaChainToolNames({}, { maxRounds: 5, home: EMPTY_HOME }), []);
  assert.deepEqual(mediaChainToolNames(SIGNED, { maxRounds: 1, home: EMPTY_HOME }), []);
  assert.deepEqual(mediaChainToolNames(SIGNED, { maxRounds: 5, home: EMPTY_HOME }), ['media_chain']);
});

test('the first call prices it and sends NOTHING', async () => {
  const root = workspace();
  const { fetchImpl, calls } = gateway({ ok: true });
  const r = await runMediaChainTool('media_chain', { chain: 'dub', path: 'in/talk.mp4', language: 'es', lipsync: true },
    { executor: { root, dryRun: false }, fetchImpl, env: SIGNED, home: EMPTY_HOME });
  assert.equal(r.spent, false);
  assert.equal(calls.length, 0);
  assert.ok(r.estimatedUsd >= mediaChainCeilingUsd('dub', { lipsync: true }) - 1e-9);
  assert.match(formatMediaChainResult(r), /NOTHING WAS PRODUCED/);
  rmSync(root, { recursive: true, force: true });
});

test('a dry run never uploads, even approved', async () => {
  const root = workspace();
  const { fetchImpl, calls } = gateway({ ok: true });
  const r = await runMediaChainTool('media_chain', { chain: 'captions', path: 'in/talk.mp4', [SPEND_APPROVAL_ARG]: true },
    { executor: { root, dryRun: true }, fetchImpl, env: SIGNED, home: EMPTY_HOME });
  assert.equal(r.spent, false);
  assert.equal(calls.length, 0);
  rmSync(root, { recursive: true, force: true });
});

test('approved: posts to the media-chain door with the bearer, downloads every clip into the workspace', async () => {
  const root = workspace();
  const { fetchImpl, calls } = gateway({
    ok: true, chain: 'shorts', estimateUsd: 0.017, notes: ['2 clip(s), ranked by hook heuristic'],
    outputs: [
      { url: 'https://signed.example/1.mp4', label: 'Why the Moon', hookScore: 9, reason: 'opens on a question', start: 56.7, end: 114.3 },
      { url: 'https://signed.example/2.mp4', label: 'Ground shook', hookScore: 7, reason: 'vivid', start: 126.3, end: 150.3 },
    ],
  });
  const r = await runMediaChainTool('media_chain', { chain: 'shorts', path: 'in/talk.mp4', count: 2, [SPEND_APPROVAL_ARG]: true },
    { executor: { root, dryRun: false }, fetchImpl, env: SIGNED, home: EMPTY_HOME });
  assert.equal(r.ok, true);
  assert.equal(r.spent, true);
  assert.equal(calls[0].url, 'https://gw.example/api/cli/v1/media-chain');
  assert.equal(calls[0].init.headers.authorization, 'Bearer xxi_test_token');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.chain, 'shorts');
  assert.equal(body.count, 2);
  assert.equal(Buffer.from(body.video_b64, 'base64').length, 2048);
  assert.equal(r.files.length, 2);
  for (const f of r.files) assert.ok(existsSync(join(root, f)), f);
  const text = formatMediaChainResult(r);
  assert.match(text, /hook heuristic 9\/10/);
  assert.doesNotMatch(text, /viral/i);
  rmSync(root, { recursive: true, force: true });
});

test('refuses a file that is not a video before anything is priced', async () => {
  const root = workspace();
  writeFileSync(join(root, 'in', 'notes.txt'), 'x');
  const r = await runMediaChainTool('media_chain', { chain: 'captions', path: 'in/notes.txt' },
    { executor: { root, dryRun: false }, fetchImpl: gateway({}).fetchImpl, env: SIGNED, home: EMPTY_HOME });
  assert.equal(r.ok, false);
  rmSync(root, { recursive: true, force: true });
});

test('the schema is offered and "dub this video" reaches it through the shortlist', () => {
  assert.equal(mediaChainToolSchemas()[0].function.name, 'media_chain');
  const offered = shortlistTools('dub this video into spanish', ['read_file', 'media_chain', 'generate_image']);
  const names = Array.isArray(offered) ? offered : offered?.tools ?? offered?.names ?? [];
  assert.ok(JSON.stringify(names).includes('media_chain'), JSON.stringify(offered).slice(0, 300));
});

test.after(() => rmSync(EMPTY_HOME, { recursive: true, force: true }));
