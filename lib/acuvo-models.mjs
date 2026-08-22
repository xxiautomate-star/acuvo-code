/**
 * ── ⭐⭐ OUR MODELS HAVE OUR NAMES ───────────────────────────────────────────
 *
 * Everywhere a user could see a model, they saw `deepseek/deepseek-v4-flash-0731`.
 * That is somebody else's product name in the middle of ours, and it is wrong
 * for three separate reasons:
 *
 *   1. **It sells the wrong thing.** A buyer comparing us to Claude Code sees
 *      "Sonnet vs Opus" against "deepseek-v4-flash-0731", and concludes we are
 *      a wrapper. The work that makes this good — the harness, the pin, the
 *      independent reviewer, the budget — is ours and is invisible in that name.
 *   2. **It leaks a decision we must be free to change.** The day a better or
 *      cheaper model appears, `--model deepseek/...` is in scripts, CI configs
 *      and muscle memory. A name we own is a name we can re-point.
 *   3. **It exposes a supplier to be approached directly.** Our margin comes
 *      from the harness and the routing, not from secrecy — but there is no
 *      reason to print the supplier list on the product.
 *
 * ⚠️ AND IT IS NOT A LIE. The underlying id is always one command away
 * (`acuvo doctor` prints it, the audit log records it, `--json` carries it), and
 * `resolveModelName` accepts a raw vendor id unchanged so nothing existing
 * breaks. Renaming is branding; hiding would be dishonesty, and this package
 * does not get to have a `refusedCommitPath` and also a secret supplier.
 *
 * ── ⚠️ TWO OF THESE ARE NOT USER-SELECTABLE, ON PURPOSE ─────────────────────
 *
 * The reviewer and the vision model are INFRASTRUCTURE. A user choosing the
 * model that reviews their work can (accidentally or otherwise) pick the same
 * one that wrote it, which turns an independent check into self-review — the
 * exact defect `chooseRefuteModel` exists to prevent. They are listed here so
 * the catalogue is complete and honest, and marked `internal` so no menu offers
 * them.
 */

/**
 * ⭐ THE ONE MAPPING. Every other module asks this file rather than embedding a
 * vendor id, so re-pointing a name is a one-line change here.
 */
export const ACUVO_MODELS = Object.freeze({
  'acuvo-flash': Object.freeze({
    name: 'acuvo-flash',
    label: 'Acuvo Flash',
    id: 'deepseek/deepseek-v4-flash-0731',
    role: 'build',
    internal: false,
    /** Measured on our own 13-task bench, 2026-08-15. */
    blurb: 'The default. 12 of 13 on our bench for 1.5 cents. Fast, and cheap enough that verifying everything is affordable.',
  }),
  'acuvo-pro': Object.freeze({
    name: 'acuvo-pro',
    label: 'Acuvo Pro',
    id: 'deepseek/deepseek-v4-pro-0813',
    role: 'build',
    internal: false,
    blurb: 'The strong model. Costs 1.2x Flash on a long warm session and 6x on a short cold one — worth it for hard, sustained work.',
  }),
  /**
   * ⚠️ INTERNAL. See the header: a user who could point the reviewer at their
   * own builder would silently convert an independent check into self-review.
   */
  'acuvo-review': Object.freeze({
    name: 'acuvo-review',
    label: 'Acuvo Review',
    id: 'qwen/qwen3.7-flash',
    role: 'review',
    internal: true,
    blurb: 'Reviews the builder\'s work from a different model family, so its blind spots are not the same ones.',
  }),
  'acuvo-vision': Object.freeze({
    name: 'acuvo-vision',
    label: 'Acuvo Vision',
    id: 'qwen/qwen3.7-flash',
    role: 'vision',
    internal: true,
    blurb: 'Looks at rendered pages and images.',
  }),
});

/** The names a user may choose between — the `/model` menu. */
export function selectableModels() {
  return Object.values(ACUVO_MODELS).filter((m) => !m.internal);
}

/**
 * Resolve whatever the user typed into a provider model id.
 *
 * ⚠️ A RAW VENDOR ID PASSES THROUGH UNCHANGED, and that is deliberate rather
 * than lazy: every existing script, CI file and test that names
 * `deepseek/deepseek-v4-flash-0731` keeps working, and anyone who wants a model
 * we have never heard of can still use it. Renaming must not become a gate.
 *
 * @param {string} input `acuvo-pro`, `Acuvo Pro`, or a raw vendor id
 * @returns {{ ok: true, id: string, model: object|null } | { ok: false, error: string }}
 */
export function resolveModelName(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: false, error: 'no model named' };

  const key = raw.toLowerCase().replace(/\s+/g, '-');
  const hit = ACUVO_MODELS[key];
  if (hit) {
    if (hit.internal) {
      return {
        ok: false,
        error: `${hit.label} is chosen for you — it ${hit.role === 'review' ? 'reviews the builder\'s work, and letting you point it at the builder\'s own model would turn an independent check into self-review' : 'is used internally'}. Pick from: ${selectableModels().map((m) => m.name).join(', ')}.`,
      };
    }
    return { ok: true, id: hit.id, model: hit };
  }

  /**
   * ⚠️ A vendor id is recognised by its slash. Anything else that is not a
   * known name is a TYPO, and a typo must not be silently posted to a provider
   * as a model id — that costs a round trip to learn "no endpoints found".
   */
  if (raw.includes('/')) {
    const known = Object.values(ACUVO_MODELS).find((m) => m.id === raw);
    return { ok: true, id: raw, model: known ?? null };
  }
  return {
    ok: false,
    error: `"${raw}" is not a model this understands. Choose ${selectableModels().map((m) => m.name).join(' or ')}, or give a full provider id like deepseek/deepseek-v4-flash-0731.`,
  };
}

/**
 * The Acuvo name for a provider id, for anything a user reads.
 *
 * ⚠️ FALLS BACK TO THE RAW ID rather than inventing a name. A model we did not
 * ship is still a model somebody is running, and printing "Acuvo Something" over
 * it would be a lie in the one place — the receipt — that has to be true.
 */
export function labelForModelId(id) {
  const hit = Object.values(ACUVO_MODELS).find((m) => m.id === String(id ?? ''));
  return hit ? hit.label : String(id ?? '');
}

/** One line per selectable model, for `--help` and the `/model` menu. */
export function formatModelMenu() {
  return selectableModels().map((m) => `  ${m.name.padEnd(12)} ${m.label.padEnd(12)} ${m.blurb}`);
}
