/**
 * ── ⭐⭐ AN IMAGE GENERATOR WITH TASTE ───────────────────────────────────────
 *
 * A generator without a critic is a slot machine. You pull it, you get what you
 * get, and the agent — which cannot see — writes `<img src="hero.jpg">` and
 * calls the page finished. Today's own coffee site did exactly that: a hero with
 * an illegible smeared label, referenced confidently in four pages.
 *
 * ⭐ SO: GENERATE → LOOK → RE-DIRECT. The same render→look→fix loop that makes
 * the code half work, applied to the creative half. Measured on the real thing:
 * qwen3.7-flash judged that hero in **6.5 seconds for $0.00004** and its verdict
 * was *"garbled and illegible text on the product label is the primary
 * disqualifier"* — score 2/10, not usable — which is precisely what a human
 * noticed and the agent could not.
 *
 * ⚠️ THE CRITIC IS THE CHEAP PART. Four thousandths of a cent against seconds of
 * GPU. There is no economic argument for shipping an unlooked-at image, and
 * there never was — we simply had no eyes.
 *
 * ── ⚠️ WHY EVERY PROMPT IS REWRITTEN, NOT PASSED THROUGH ────────────────────
 * A coding model asked for "an image of a coffee bag" writes exactly that, and
 * gets the flat, grey, stock-photo mush that makes generated pages look
 * generated. Image models respond to DIRECTION — lens, light, composition,
 * grade. Supplying it is not decoration, it is the difference between an asset
 * and a placeholder.
 */

/**
 * ⚠️ THE SINGLE MOST VALUABLE RULE HERE, AND IT CAME FROM THE CRITIC.
 * Diffusion models cannot spell. Asking for a label, a sign, a logo or a UI
 * guarantees garbled glyphs, and garbled text is the one defect a viewer
 * notices instantly and reads as "made by a machine". So requests for text are
 * actively REMOVED and replaced with a composition that does not need any.
 *
 * A human art director does this without being asked. It is the whole job.
 */
const TEXT_REQUESTS = /\b(text|label(?:led|led)?|logo|sign|signage|words?|writing|typography|caption|title|lettering|banner|poster|menu|headline)\b/gi;

/** Direction that reads as cinema rather than stock photography. */
const CINEMATIC = [
  'cinematic still',
  'shallow depth of field',
  'volumetric directional light',
  'rich colour grade with lifted shadows',
  'shot on 35mm, subtle film grain',
  'composed off-centre with negative space',
];

/**
 * Turn a plain request into a directed one.
 *
 * ⚠️ THE USER'S SUBJECT IS NEVER DISCARDED — direction is appended, not
 * substituted. A "cinematic" rewrite that loses what was asked for is a worse
 * failure than a flat image, because the page ends up showing the wrong thing
 * beautifully.
 */
export function cinematicPrompt(prompt, { mode = 'cinematic', avoidText = true } = {}) {
  const subject = String(prompt ?? '').trim();
  if (!subject) return { prompt: '', strippedText: false };

  let base = subject;
  let strippedText = false;
  if (avoidText && TEXT_REQUESTS.test(subject)) {
    TEXT_REQUESTS.lastIndex = 0;
    // Rather than delete the noun and leave a hole, neutralise it: the object
    // stays, its unrenderable surface detail goes.
    base = subject.replace(TEXT_REQUESTS, '').replace(/\s{2,}/g, ' ').replace(/\s+([,.])/g, '$1').trim();
    strippedText = true;
  }

  /**
   * ── ⚠️⭐ MEASURED: A NEGATIVE PROMPT DOES NOT WORK, SO RE-COMPOSE INSTEAD ──
   *
   * Run live against the fallback provider: "no text, no lettering, no logos"
   * was in the prompt all three times and every shot came back with a garbled
   * label. The critic's verdict, three times identically: *"garbled and
   * completely illegible text on the label"*, score 2/10.
   *
   * ⚠️ Re-prompting cannot rescue a subject that CONTAINS text. A coffee bag has
   * a label; asking politely for it to be blank does not remove it from the
   * model's idea of a coffee bag, and most endpoints ignore negative phrasing
   * entirely.
   *
   * ⭐ WHAT A REAL ART DIRECTOR DOES: if the label cannot be rendered, do not
   * shoot the label. Turn it away, crop past it, or shoot the product out of its
   * packaging. That is a COMPOSITION instruction, which models obey, instead of
   * a prohibition, which they do not.
   */
  const packaged = /\b(bag|packet|pouch|box|bottle|can|jar|tin|carton|book|magazine|poster|shopfront|storefront|screen|monitor|laptop|phone)\b/i.test(base);
  const composition = avoidText && (strippedText || packaged)
    ? 'framed so no printed surface faces the camera, label turned away or cropped out of frame, focus on material and texture'
    : '';

  const direction = mode === 'flat'
    ? ['clean product photography', 'even soft light', 'plain background']
    : CINEMATIC;

  const negative = avoidText
    // ⚠️ Stated positively as well as negatively: many endpoints ignore a
    // negative-prompt convention entirely, so the instruction has to survive in
    // the positive prompt too.
    ? 'no text, no lettering, no logos, no watermarks, clean unmarked surfaces'
    : '';

  return {
    // Composition goes BEFORE the grade: it is an instruction about what is in
    // the frame, and the grade only describes how the frame looks.
    prompt: [base, composition, ...direction, negative].filter(Boolean).join(', '),
    strippedText,
    recomposed: Boolean(composition),
  };
}

/**
 * ⭐ CHOSEN ON MEASURED COST, NOT REPUTATION. qwen3.7-flash judged a real image
 * in 6.5s for $0.00004; qwen2.5-vl-72b gave a near-identical verdict for 6x the
 * price. When two models agree, the cheap one is the right one.
 */
export const DEFAULT_CRITIC_MODEL = 'qwen/qwen3.7-flash';

const CRITIC_TIMEOUT_MS = 60_000;

const CRITIC_BRIEF = [
  'You are an art director reviewing a generated image before it goes on a client website.',
  'Reply with ONLY a JSON object, no prose, no code fence:',
  '{"usable":true|false,"score":0-10,"problems":["..."],"betterPrompt":"..."}',
  'Be harsh. Any of these makes it NOT usable: garbled or misspelled text, malformed hands or',
  'faces, duplicated limbs, mushy or melted detail, a watermark, or a subject that is not what',
  'was asked for. "betterPrompt" must be a complete replacement prompt that would fix the',
  'problems — and it must not ask for any text, because the generator cannot spell.',
].join(' ');

/**
 * Look at an image and say whether it is good enough.
 *
 * ⚠️ RETURNS ok:false RATHER THAN A GUESS WHEN IT CANNOT TELL. An art director
 * who bluffs is worse than none: a fabricated "looks great" would launder a bad
 * asset through a process that exists to catch it. Every failure path here
 * abstains loudly.
 */
export async function critiqueImage(imageBytes, intent, {
  apiKey = process.env.OPENROUTER_API_KEY,
  model = DEFAULT_CRITIC_MODEL,
  mimeType = 'image/jpeg',
  fetchImpl = fetch,
} = {}) {
  if (!apiKey) return { ok: false, error: 'no OPENROUTER_API_KEY, so the image cannot be looked at' };
  if (!imageBytes || imageBytes.length < 1000) return { ok: false, error: 'there is no image here to look at' };

  const dataUrl = `data:${mimeType};base64,${Buffer.from(imageBytes).toString('base64')}`;
  let res;
  try {
    res = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: 500,
        // ⚠️ Reasoning OFF. On a reasoning model the thinking budget is charged
        // against max_tokens and can consume all of it, returning zero content —
        // measured on this exact account today, 15,999 reasoning tokens and an
        // empty reply.
        reasoning: { enabled: false },
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: `${CRITIC_BRIEF}\n\nThe image was meant to be: ${String(intent).slice(0, 400)}` },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        }],
      }),
      signal: AbortSignal.timeout(CRITIC_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, error: `could not reach the critic: ${err?.name ?? err}` };
  }
  if (!res.ok) return { ok: false, error: `the critic returned HTTP ${res.status}` };

  let text;
  try {
    const j = await res.json();
    text = j?.choices?.[0]?.message?.content ?? '';
  } catch {
    return { ok: false, error: 'the critic returned a body that was not JSON' };
  }

  const parsed = parseVerdict(text);
  if (!parsed) return { ok: false, error: 'the critic did not answer in the required shape' };
  return { ok: true, ...parsed };
}

/**
 * ⚠️ MODELS FENCE THEIR JSON EVEN WHEN TOLD NOT TO, and they add a sentence
 * before it. Refusing to parse that would abstain on a perfectly good verdict,
 * so the object is extracted rather than the whole string trusted.
 */
export function parseVerdict(text) {
  if (!text) return null;
  const body = String(text).replace(/```(?:json)?/gi, '');
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let obj;
  try { obj = JSON.parse(body.slice(start, end + 1)); } catch { return null; }
  if (typeof obj !== 'object' || obj === null) return null;

  const score = Number(obj.score);
  return {
    // ⚠️ A missing verdict is treated as NOT usable. The whole point is to catch
    // bad assets, so an unparseable opinion must not read as approval.
    usable: obj.usable === true,
    score: Number.isFinite(score) ? Math.max(0, Math.min(10, score)) : 0,
    problems: Array.isArray(obj.problems) ? obj.problems.map(String).slice(0, 6) : [],
    betterPrompt: typeof obj.betterPrompt === 'string' && obj.betterPrompt.trim() ? obj.betterPrompt.trim() : null,
  };
}

/** Below this, re-shoot. 7 is "a client would accept it". */
export const ACCEPT_SCORE = 7;

/**
 * ── ⭐ THE DIRECTOR: SHOOT, LOOK, RE-SHOOT ──────────────────────────────────
 *
 * @param generate  async ({ prompt }) => { ok, path, bytes, absolutePath, mimeType }
 *
 * ⚠️ BOUNDED AT TWO RE-SHOOTS AND THAT IS A COST DECISION, not a quality one. A
 * loop that keeps going until it is happy is exactly the unmetered loop that
 * makes this product lose money per call, and image models plateau fast: if the
 * third attempt is still wrong, the fourth will be too.
 *
 * ⚠️ AND IT ALWAYS RETURNS THE BEST ATTEMPT, never nothing. A page with a
 * mediocre hero is a page; a page with no hero is a bug. What changes is that
 * the caller is TOLD the score, so it can mention it rather than pretend.
 */
export async function directImage({
  prompt,
  generate,
  readBytes,
  mode = 'cinematic',
  maxAttempts = 3,
  acceptScore = ACCEPT_SCORE,
  apiKey = process.env.OPENROUTER_API_KEY,
  criticModel = DEFAULT_CRITIC_MODEL,
  fetchImpl = fetch,
}) {
  const directed = cinematicPrompt(prompt, { mode });
  let current = directed.prompt;
  const attempts = [];
  let best = null;

  for (let i = 0; i < Math.max(1, maxAttempts); i += 1) {
    const shot = await generate({ prompt: current });
    if (!shot?.ok) {
      attempts.push({ attempt: i + 1, error: shot?.error ?? 'generation failed' });
      // ⚠️ A generation failure is not a critique failure — stop, do not burn
      // the remaining attempts on a provider that is down. The breaker upstream
      // already decided this endpoint is not answering.
      break;
    }

    let verdict = null;
    if (apiKey) {
      const bytes = readBytes ? readBytes(shot) : null;
      if (bytes) {
        verdict = await critiqueImage(bytes, prompt, {
          apiKey, model: criticModel, fetchImpl,
          mimeType: shot.mimeType ?? (String(shot.path).endsWith('.png') ? 'image/png' : 'image/jpeg'),
        });
      }
    }

    const score = verdict?.ok ? verdict.score : null;
    attempts.push({ attempt: i + 1, path: shot.path, score, problems: verdict?.ok ? verdict.problems : [], criticError: verdict?.ok ? null : verdict?.error ?? 'not looked at' });

    /**
     * ⚠️ AN UNSCORED SHOT WINS ONLY IF NOTHING IS SCORED. Treating "could not
     * look" as a passing grade would silently disable the whole mechanism the
     * moment the critic has a bad day — the exact shape of failure that let a
     * blind audit issue all-clears for eighteen commits.
     */
    if (!best || (score ?? -1) > (best.score ?? -1)) best = { ...shot, score, problems: verdict?.ok ? verdict.problems : [] };

    if (score === null) break;              // no eyes available; one shot is all we can justify
    if (score >= acceptScore) break;        // good enough — stop spending

    /**
     * ── ⚠️⭐ PLATEAU: A RE-SHOOT THAT DID NOT IMPROVE WILL NOT IMPROVE ───────
     *
     * Measured live: three attempts at the same subject scored 2, 2, 2 — the
     * critic's rewritten prompt each time, and 100 seconds of wall clock to
     * arrive back where it started. The defect was structural (a coffee bag has
     * a label and the model cannot spell), and no amount of re-prompting fixes a
     * structural defect.
     *
     * ⭐ So the loop stops when a shot fails to BEAT the previous one, rather
     * than running out its budget. One wasted re-shoot to discover the plateau
     * is a fair price; two is just paying to be told again.
     */
    const previous = attempts[attempts.length - 2];
    if (previous && typeof previous.score === 'number' && score <= previous.score) {
      attempts[attempts.length - 1].stoppedBecause = 'plateau — re-shooting did not improve the score';
      break;
    }
    if (i === maxAttempts - 1) break;
    if (verdict?.betterPrompt) {
      // Re-direct using the critic's own rewrite, then re-apply house direction
      // so a plain rewrite does not undo the cinematic grade.
      current = cinematicPrompt(verdict.betterPrompt, { mode }).prompt;
    }
  }

  if (!best) return { ok: false, error: attempts[attempts.length - 1]?.error ?? 'no image was produced', attempts };
  return {
    ok: true,
    ...best,
    directedPrompt: directed.prompt,
    strippedText: directed.strippedText,
    attempts,
    // Honest, and it belongs in the summary the user reads.
    accepted: (best.score ?? 0) >= acceptScore,
  };
}
