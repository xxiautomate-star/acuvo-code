/**
 * ── ⭐⭐ THE MULTIMODAL CORPUS — THE HALF NO OTHER CODING AGENT BENCHES ───────
 *
 * Acuvo Code ships five tools that produce or consume something other than
 * text: `speak`, `transcribe`, `see_page`, `make_document` and `generate_image`.
 * Nothing measured them until now, and "we have a TTS tool" is not a capability
 * claim — a capability claim is an artefact on disk that a machine can check.
 *
 * ⚠️ EVERY ONE OF THEM WAS DARK BY DEFAULT. `toolNamesForRounds` gates the four
 * media tools on RENDER_AUDIT_URL / MODAL_TTS_URL / MODAL_TRANSCRIBE_URL /
 * MODAL_PRESS_URL, and on a machine where those are unset the model is never
 * TOLD the capability exists. Measured 2026-08-11: all nine Modal endpoints
 * answer (405 on GET is Modal's POST-only signature, and the face gateway's 404
 * on its base URL is correct — it has no root route), so the entire multimodal
 * half was live and unreachable for want of four environment variables. That is
 * this package's signature failure — built, tested, and not connected — showing
 * up one more time, at the configuration layer.
 *
 * ── ⚠️ HOW THESE ARE GRADED, AND WHY IT MATTERS MORE HERE THAN ANYWHERE ─────
 * MECHANICALLY, like the rest of the corpus. No model judges any output.
 * The temptation is strongest here — "is this a good image?" is exactly the sort
 * of question people hand to a vision model — and it must be refused: a critic
 * scored five of six pages identically when this project asked it for taste, so
 * a grader that can be wrong tells you nothing about the thing it is grading.
 *
 * So every check below is a fact a machine can settle on its own:
 *   · PDF/PPTX/PNG/WAV magic bytes and a plausible size
 *   · WCAG contrast, computed from the two colours in the file
 *   · word overlap between what was spoken and what came back transcribed
 *
 * ── ⚠️ A FAILURE HERE MUST NAME THE ENVIRONMENT, NOT THE MODEL ──────────────
 * If MODAL_TTS_URL is unset the `speak` tool is never offered, the task fails,
 * and the honest reason is "not configured" — not "the agent could not do it".
 * Every task therefore reports that case in its own words. A bench that blames
 * the model for a missing environment variable teaches you the wrong lesson,
 * and this corpus exists precisely because the missing variable WAS the bug.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const read = (ws, p) => { try { return readFileSync(join(ws, p), 'utf8'); } catch { return ''; } };
const bytes = (ws, p) => { try { return readFileSync(join(ws, p)); } catch { return null; } };

/** Every file in the workspace, recursively, excluding our own bookkeeping. */
function allFiles(ws, dir = ws, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === '.acuvo' || e.name === 'node_modules' || e.name === '.git') continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) allFiles(ws, abs, out);
    else if (e.isFile()) out.push(abs);
  }
  return out;
}

/** The first file whose leading bytes match `magic`, or null. */
function fileWithMagic(ws, magic, minBytes = 512) {
  for (const abs of allFiles(ws)) {
    try {
      const b = readFileSync(abs);
      if (b.length >= minBytes && b.subarray(0, magic.length).equals(magic)) return { abs, size: b.length };
    } catch { /* unreadable */ }
  }
  return null;
}

function anyFileMatching(ws, rx) {
  return allFiles(ws).filter((f) => rx.test(f)).map((f) => ({ abs: f, size: statSync(f).size }));
}

/**
 * ⭐ Did the model even get OFFERED the tool? `.acuvo/audit/` records every run,
 * so a task can tell "the capability was withheld" from "the agent ignored it".
 * That distinction is the whole reason this corpus is trustworthy.
 */
function toolWasUnavailable(ws, toolName) {
  const dir = join(ws, '.acuvo', 'audit');
  if (!existsSync(dir)) return false;
  for (const f of readdirSync(dir)) {
    const body = read(ws, join('.acuvo', 'audit', f));
    if (body.includes(toolName)) return false;
  }
  return true;
}

/** WCAG relative luminance, from a #rrggbb string. */
function luminance(hex) {
  const n = hex.replace('#', '');
  const full = n.length === 3 ? n.split('').map((c) => c + c).join('') : n;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrastRatio(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

export const MULTIMODAL_TASKS = [
  {
    id: 'voice-loop',
    what: 'MULTIMODAL — speak a sentence, then transcribe the audio back and prove the loop closed',
    rounds: 6,
    setup: { files: { 'package.json': '{"name":"voice","type":"module"}\n' } },
    prompt:
      'Use the speak tool to synthesise this exact sentence to an audio file: '
      + '"The quick brown fox jumps over the lazy dog near the riverbank." '
      + 'Then use the transcribe tool on the audio file you just created, and write the transcript it '
      + 'returned into transcript.txt. The transcript must come from the transcribe tool — do not write '
      + 'the sentence from memory.',
    checks: [
      (ws) => {
        const audio = anyFileMatching(ws, /\.(wav|mp3|ogg|m4a|flac)$/i);
        if (audio.length === 0) {
          return toolWasUnavailable(ws, 'speak')
            ? 'NOT CONFIGURED — no audio file, and `speak` was never offered (MODAL_TTS_URL unset). This is an environment failure, not a model failure.'
            : 'no audio file was produced';
        }
        return audio.some((a) => a.size > 4_000) ? null : `audio file is implausibly small (${audio[0].size} bytes)`;
      },
      (ws) => (existsSync(join(ws, 'transcript.txt')) ? null : 'transcript.txt was never written'),
      /**
       * ⭐ THE LOOP-CLOSED CHECK, and the reason this task is worth more than two
       * separate ones. Word overlap, not equality: a real speech-to-text pass
       * legitimately differs in punctuation, casing and the odd homophone, so
       * demanding an exact string would fail a perfectly working pipeline. Six of
       * the nine content words is a wide margin that still cannot be reached by
       * a transcript the model invented from a DIFFERENT sentence.
       */
      (ws) => {
        const said = ['quick', 'brown', 'fox', 'jumps', 'lazy', 'dog', 'riverbank'];
        const got = read(ws, 'transcript.txt').toLowerCase();
        if (!got.trim()) return 'transcript.txt is empty';
        const hits = said.filter((w) => got.includes(w));
        return hits.length >= 5
          ? null
          : `the transcript does not match what was spoken — only ${hits.length}/7 content words present: "${got.slice(0, 120)}"`;
      },
    ],
  },

  {
    id: 'look-and-fix',
    what: 'MULTIMODAL — render a page, SEE a real defect in it, and fix that defect',
    rounds: 7,
    setup: {
      files: {
        'package.json': '{"name":"look","type":"module"}\n',
        /**
         * ⚠️ THE DEFECT IS INVISIBLE TO EVERY TEXT CHECK AND OBVIOUS ON SIGHT:
         * #eeeeee text on a #f0f0f0 background is a contrast ratio of about
         * 1.09:1 against a required 4.5:1. Nothing about the HTML is malformed,
         * no linter complains, and the page is unreadable.
         */
        'index.html':
          '<!doctype html>\n<html><head><meta charset="utf-8"><title>Pricing</title>\n'
          + '<style>\n'
          + '  body { background: #f0f0f0; font-family: system-ui, sans-serif; margin: 0; padding: 48px; }\n'
          + '  h1 { color: #eeeeee; font-size: 40px; }\n'
          + '  p  { color: #eeeeee; font-size: 18px; max-width: 60ch; }\n'
          + '</style></head>\n<body>\n'
          + '  <h1>Simple pricing</h1>\n'
          + '  <p>One plan, everything included, cancel any time. No hidden fees and no surprises.</p>\n'
          + '</body></html>\n',
      },
    },
    prompt:
      'Use the see_page tool to look at index.html and report what is wrong with it. Then fix the problem '
      + 'it found, in index.html. Do not redesign the page — change only what is needed to fix the defect.',
    checks: [
      (ws) => {
        const html = read(ws, 'index.html');
        if (!html) return 'index.html is gone';
        const bg = (html.match(/background:\s*(#[0-9a-f]{3,6})/i) ?? [])[1];
        const fg = (html.match(/color:\s*(#[0-9a-f]{3,6})/i) ?? [])[1];
        if (!bg || !fg) return null; // colours restated some other way; the ratio check below is the real one
        const ratio = contrastRatio(fg, bg);
        return ratio >= 4.5
          ? null
          : `text is still unreadable — ${fg} on ${bg} is ${ratio.toFixed(2)}:1, and 4.5:1 is the floor`;
      },
      // ANTI-CHEAT: deleting the text is not a contrast fix.
      (ws) => (/Simple pricing/.test(read(ws, 'index.html')) ? null : 'the heading was deleted rather than made readable'),
      (ws) => (/cancel any time/i.test(read(ws, 'index.html')) ? null : 'the body copy was deleted rather than made readable'),
      /**
       * ⭐ THE CAPABILITY BEING MEASURED. The fix could be reached by luck — a
       * model that never looked might still change a colour. So the run must
       * show `see_page` actually ran; otherwise this task is measuring guessing.
       */
      (ws) => (toolWasUnavailable(ws, 'see_page')
        ? 'NOT CONFIGURED — `see_page` was never offered (RENDER_AUDIT_URL unset). Environment failure, not a model failure.'
        : null),
    ],
  },

  {
    id: 'press-doc',
    what: 'MULTIMODAL — turn written content into a real PDF a machine can validate',
    rounds: 6,
    setup: {
      files: {
        'package.json': '{"name":"press","type":"module"}\n',
        'REPORT.md':
          '# Q3 Infrastructure Review\n\n'
          + '## Summary\n\nSpend fell 41% after the migration off per-hour GPU billing.\n\n'
          + '## Detail\n\n- Idle billing eliminated\n- Cold starts now 14.6s warm\n- Cost per render: $0.0016\n',
      },
    },
    prompt: 'Use the make_document tool to turn REPORT.md into a PDF file in this directory.',
    checks: [
      (ws) => {
        const pdf = fileWithMagic(ws, Buffer.from('%PDF'), 1_000);
        if (pdf) return null;
        return toolWasUnavailable(ws, 'make_document')
          ? 'NOT CONFIGURED — no PDF, and `make_document` was never offered (MODAL_PRESS_URL unset). Environment failure, not a model failure.'
          : 'no file in the workspace begins with %PDF and is over 1KB — nothing was actually pressed';
      },
      // ANTI-CHEAT: a .pdf-named text file is not a PDF.
      (ws) => {
        const named = anyFileMatching(ws, /\.pdf$/i);
        if (named.length === 0) return null;
        const bad = named.filter((f) => {
          const b = bytes(ws, f.abs);
          return !b || !b.subarray(0, 4).equals(Buffer.from('%PDF'));
        });
        return bad.length === 0 ? null : `${bad.length} file(s) named .pdf are not PDFs — the extension was faked`;
      },
      (ws) => (/Q3 Infrastructure Review/.test(read(ws, 'REPORT.md')) ? null : 'the source document was destroyed'),
    ],
  },

  {
    id: 'image-real',
    what: 'MULTIMODAL — generate an image and prove it is a real decodable raster, not a placeholder',
    rounds: 5,
    setup: { files: { 'package.json': '{"name":"img","type":"module"}\n' } },
    prompt: 'Use the generate_image tool to create an image of a red vintage bicycle leaning against a stone wall, and save it in this directory.',
    checks: [
      (ws) => {
        const png = fileWithMagic(ws, Buffer.from([0x89, 0x50, 0x4e, 0x47]), 8_000);
        const jpg = fileWithMagic(ws, Buffer.from([0xff, 0xd8, 0xff]), 8_000);
        if (png || jpg) return null;
        return toolWasUnavailable(ws, 'generate_image')
          ? 'NOT CONFIGURED — `generate_image` was never offered.'
          : 'no PNG or JPEG over 8KB was produced — nothing was actually generated';
      },
      /**
       * ⭐ DIMENSIONS FROM THE HEADER, because "a file exists" is a weaker claim
       * than it sounds: a 1x1 pixel or an error page saved with a .png extension
       * both satisfy "there is a file". Read the IHDR and insist on a real canvas.
       */
      (ws) => {
        const png = fileWithMagic(ws, Buffer.from([0x89, 0x50, 0x4e, 0x47]), 8_000);
        if (!png) return null; // a JPEG answer is fine; the size floor above covers it
        const b = readFileSync(png.abs);
        const w = b.readUInt32BE(16);
        const h = b.readUInt32BE(20);
        return w >= 256 && h >= 256 ? null : `the PNG is ${w}x${h} — too small to be a real generation`;
      },
    ],
  },
];

export const MULTIMODAL_IDS = MULTIMODAL_TASKS.map((t) => t.id);
