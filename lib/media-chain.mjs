/**
 * ── ⭐ media_chain — captions, dubbing, long video → ranked shorts ──────────
 *
 * The CLI door onto `console/lib/media-chains.ts`. Three chains, one verb:
 *
 *   captions  word-by-word burned captions (the spoken word lit)
 *   dub       transcript → translation → speech in the target language →
 *             the mouth re-synced to it (`lipsync: true`) or the voice laid over
 *   shorts    a long video cut into ranked 9:16 clips, each with the ranker's
 *             reason and a HOOK HEURISTIC score — read from the words, never a
 *             prediction of views, and never called one
 *
 * ── ⚠️ GATEWAY ONLY, AND THAT IS NOT AN OMISSION ────────────────────────────
 * Every other media verb here has a "direct" leg for somebody running their own
 * Modal worker. This one cannot: the chain spends FAL (speech, lip-sync) and
 * OpenRouter (translation, ranking) on keys that live on the server, and the
 * per-tenant meter rows are written there. So it is offered only to a
 * signed-in account (`acuvo --login`), and never mentioned otherwise.
 *
 * ── ⚠️ IT PRICES FIRST AND SPENDS ON THE SECOND CALL ─────────────────────────
 * The same `spendGate` contract as `viral`/`podcast`: the first call returns a
 * CEILING estimate and generates nothing; the model reads it to the user and
 * calls again with `approve_spend: true`. The estimate is a ceiling because the
 * video's length is not known until the server has heard it.
 *
 * ⚠️ `acuvo-code` never imports from `console/` — the prices below restate the
 * registry's published unit prices and are only used for the ceiling; the
 * server's own figure is what gets charged to `--budget` afterwards.
 */
import { readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, extname, basename } from 'node:path';
import { resolveInWorkspace } from './workspace.mjs';
import { readAccount } from './account.mjs';
import { mediaChainEndpoint } from './creative-engines.mjs';
import { MAX_GATEWAY_UPLOAD_BYTES } from './media.mjs';
import { spendGate, SPEND_APPROVAL_ARG } from './media-pipeline.mjs';
import { chargeEstimate } from './budget.mjs';

export const MEDIA_CHAIN_TOOL_NAMES = Object.freeze(['media_chain']);
export const MEDIA_CHAIN_KINDS = Object.freeze(['captions', 'dub', 'shorts']);
export const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm']);

/** Ceiling-only prices — see the header. FAL speech per run, Sync lip-sync per output second. */
const SPEECH_USD = 0.025;
const LIPSYNC_USD_PER_S = 0.011667;
const DUB_MAX_S = 60;

export function mediaChainCeilingUsd(chain, { lipsync = false, count = 3 } = {}) {
  if (chain === 'captions') return 0.005;
  if (chain === 'shorts') return 0.005 * Math.max(1, count) + 0.002;
  return 0.007 + SPEECH_USD + (lipsync ? LIPSYNC_USD_PER_S * DUB_MAX_S * 1.25 : 0);
}

function route(env, home) {
  const account = readAccount(env, ...(home === undefined ? [] : [home]));
  const token = account?.token?.trim?.() || null;
  const url = token ? mediaChainEndpoint(account.gatewayUrl) : null;
  return url ? { url, token } : null;
}

/** Offered only with an account to route through, and never on a single-shot turn (it prices first). */
export function mediaChainToolNames(env = process.env, { maxRounds = 2, home = undefined } = {}) {
  if (maxRounds <= 1) return [];
  return route(env, home) ? [...MEDIA_CHAIN_TOOL_NAMES] : [];
}

export function mediaChainToolSchemas() {
  return [{
    type: 'function',
    function: {
      name: 'media_chain',
      description: [
        'Work on a video file in the workspace: captions (word-by-word, burned in), dub (translate the speech',
        'and re-voice it in another language; lipsync:true re-syncs the mouth when a face speaks on camera), or',
        'shorts (cut a long video into ranked vertical clips, each with a reason and a hook-heuristic score).',
        `⚠️ SPENDS: the first call prices it and makes nothing; tell the user, then call again with ${SPEND_APPROVAL_ARG}: true.`,
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          chain: { type: 'string', enum: [...MEDIA_CHAIN_KINDS] },
          path: { type: 'string', description: 'Workspace-relative video (.mp4 .mov .m4v .webm), up to 3MB.' },
          language: { type: 'string', description: "dub only: target language, e.g. 'es'." },
          lipsync: { type: 'boolean', description: 'dub only: a face speaks on camera.' },
          count: { type: 'integer', description: 'shorts only: 1-5 clips, default 3.' },
          aspect: { type: 'string', enum: ['9:16', '1:1', '4:5', '16:9'], description: 'captions only: reframe too.' },
          out_dir: { type: 'string', description: 'Where the results go. Default "video".' },
          [SPEND_APPROVAL_ARG]: { type: 'boolean', description: 'Set true ONLY after the user has seen the estimate.' },
        },
        required: ['chain', 'path'],
      },
    },
  }];
}

function slug(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'clip';
}

/**
 * Run the verb. Never throws — a failure is data, like every media verb here.
 * `fetchImpl`, `env` and `home` are injected so the whole path is testable
 * with no network and no real account.
 */
export async function runMediaChainTool(_name, args = {}, {
  executor = { root: process.cwd(), dryRun: false },
  budget = null,
  fetchImpl = fetch,
  env = process.env,
  home = undefined,
} = {}) {
  const chain = String(args.chain ?? '').trim();
  if (!MEDIA_CHAIN_KINDS.includes(chain)) return { ok: false, error: `chain must be one of ${MEDIA_CHAIN_KINDS.join(', ')}` };
  const via = route(env, home);
  if (!via) return { ok: false, error: 'media_chain runs on your Acuvo plan — sign in with `acuvo --login` first.' };
  if (chain === 'dub' && !String(args.language ?? '').trim()) return { ok: false, error: 'dub needs a target `language`, e.g. "es".' };

  const target = resolveInWorkspace(executor.root, args.path, 'read');
  if (!target.ok) return { ok: false, error: target.reason };
  if (!VIDEO_EXTENSIONS.has(extname(target.absolute).toLowerCase())) {
    return { ok: false, error: `${target.relative} is not a video file (${[...VIDEO_EXTENSIONS].join(' ')}).` };
  }
  let bytes;
  try { bytes = statSync(target.absolute).size; } catch (err) { return { ok: false, error: `could not read ${target.relative}: ${err?.message ?? err}` }; }
  if (bytes > MAX_GATEWAY_UPLOAD_BYTES) {
    return {
      ok: false,
      error: `${target.relative} is ${(bytes / 1024 / 1024).toFixed(1)}MB, over the ${Math.round(MAX_GATEWAY_UPLOAD_BYTES / 1024 / 1024)}MB `
        + 'upload limit through your plan. Trim it or lower the resolution first.',
    };
  }

  const lipsync = chain === 'dub' && args.lipsync === true;
  const count = chain === 'shorts' ? Math.min(5, Math.max(1, Math.floor(Number(args.count) || 3))) : undefined;
  const ceiling = mediaChainCeilingUsd(chain, { lipsync, count });
  const gate = spendGate({ approved: args[SPEND_APPROVAL_ARG], dryRun: executor.dryRun, estimateUsd: ceiling, budget, verb: 'media_chain' });
  if (!gate.go) return { ok: true, spent: false, estimatedUsd: ceiling, next: `${gate.why} Ceiling for this run: $${ceiling.toFixed(3)}.` };

  let res;
  try {
    res = await fetchImpl(via.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${via.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        chain,
        video_b64: readFileSync(target.absolute).toString('base64'),
        filename: basename(target.relative),
        ...(chain === 'dub' ? { language: String(args.language), lipsync } : {}),
        ...(count ? { count } : {}),
        ...(chain === 'captions' && args.aspect ? { aspect: String(args.aspect) } : {}),
      }),
      signal: AbortSignal.timeout(300_000),
    });
  } catch (err) {
    return { ok: false, error: `the media chain is unreachable: ${err?.name === 'TimeoutError' ? 'timed out after 300s' : err?.message ?? err}` };
  }
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.ok) {
    return { ok: false, error: json?.error?.message ?? json?.error ?? `the media chain answered HTTP ${res.status}` };
  }
  const usd = Number(json.estimateUsd);
  if (Number.isFinite(usd) && usd > 0) {
    chargeEstimate({ kind: 'media', verb: 'media_chain', usd, basis: `server ceiling for ${chain} (FAL + OpenRouter + Modal, metered per tenant server-side)` });
  }

  const outDir = String(args.out_dir ?? 'video').replace(/^\/+/, '') || 'video';
  const files = [];
  const outputs = [];
  for (const [i, o] of (Array.isArray(json.outputs) ? json.outputs : []).entries()) {
    const rel = `${outDir}/${slug(basename(target.relative, extname(target.relative)))}-${chain}-${i + 1}-${slug(o.label)}.mp4`;
    const dest = resolveInWorkspace(executor.root, rel, 'write');
    if (!dest.ok) return { ok: false, error: dest.reason };
    try {
      const got = await fetchImpl(o.url, { signal: AbortSignal.timeout(120_000) });
      if (!got.ok) throw new Error(`HTTP ${got.status}`);
      mkdirSync(dirname(dest.absolute), { recursive: true });
      writeFileSync(dest.absolute, Buffer.from(await got.arrayBuffer()));
      files.push(dest.relative);
      outputs.push({ path: dest.relative, label: o.label, ...(o.reason ? { reason: o.reason } : {}),
        ...(typeof o.hookScore === 'number' ? { hookScore: o.hookScore } : {}),
        ...(typeof o.start === 'number' ? { start: o.start, end: o.end } : {}),
        ...(typeof o.seconds === 'number' ? { seconds: o.seconds } : {}) });
    } catch (err) {
      outputs.push({ path: null, label: o.label, url: o.url, error: `could not download: ${err?.message ?? err}` });
    }
  }
  return { ok: true, spent: true, chain, dir: outDir, files, outputs, notes: Array.isArray(json.notes) ? json.notes : [], estimatedUsd: usd };
}

/** What the model reads back. `spent` first — whether money moved decides the next action. */
export function formatMediaChainResult(result) {
  if (!result?.ok) return `media_chain failed: ${result?.error ?? 'unknown error'}`;
  if (result.spent === false) return `media_chain: NOTHING WAS PRODUCED and nothing was spent.\n${result.next}`;
  const lines = [`media_chain ${result.chain}: ${result.files.length} file(s) in ${result.dir}`];
  for (const o of result.outputs) {
    const bits = [o.path ?? `(not saved: ${o.error})`, o.label];
    if (typeof o.hookScore === 'number') bits.push(`hook heuristic ${o.hookScore}/10`);
    if (typeof o.start === 'number') bits.push(`${o.start}s–${o.end}s of the source`);
    lines.push(`- ${bits.join(' · ')}${o.reason ? ` — ${o.reason}` : ''}`);
  }
  for (const n of result.notes) lines.push(`· ${n}`);
  if (Number.isFinite(result.estimatedUsd)) lines.push(`spent at most $${result.estimatedUsd.toFixed(3)}`);
  return lines.join('\n');
}
