/**
 * ── ⭐⭐ DEEPSEEK BILLS DOUBLE FOR SEVEN HOURS A DAY ─────────────────────────
 *
 * `lib/model.mjs` already records the fact and acts on it: direct DeepSeek is
 * 3.7x dearer on OUTPUT than OpenRouter and doubles during peak, measured over
 * 95M tokens as **62.3% margin against 85.6%**. That is why `directDeepSeek` is
 * gated behind `ACUVO_DEEPSEEK_DIRECT=1` and off by default.
 *
 * ── ⚠️ SO WHY THIS MODULE EXISTS ────────────────────────────────────────────
 *
 * Because ONE CALLER TURNS THAT GATE ON: the benchmark. Roman, 2026-08-23:
 * *"you haven't been using our direct DeepSeek API credits for the benchmark,
 * you've been using OpenRouter, which we want to save for users."* That is a
 * deliberate decision and this module does not argue with it — a benchmark is
 * our cost, not a customer's.
 *
 * ⭐ BUT IT MEANS OUR OWN BIGGEST SPENDER SITS ON THE PEAK-EXPOSED PATH, and
 * nothing anywhere said so. A 3.5-hour bench started at 06:05 UTC pays double
 * for its entire run; the same run started at 10:05 pays half. Nobody was
 * choosing that — they just started it when they happened to be at the desk.
 *
 * ⚠️ IT DOES NOT DEFER, DELAY OR RE-ROUTE ANYTHING. Deciding to wait four hours
 * is the operator's call, and a tool that silently queues a job somebody wanted
 * NOW is worse than one that says the price. This module only ever answers
 * questions.
 *
 * Windows are DeepSeek's published peak hours: 01:00–04:00 and 06:00–10:00 UTC,
 * **Monday to Friday**. In Roman's timezone (AEST, UTC+10) that is 11:00–14:00
 * and 16:00–20:00 — i.e. most of an Australian working afternoon.
 *
 * ── ⚠️ THE WEEKDAY HALF OF THE SCHEDULE WAS MISSING (fixed 2026-08-25) ──────
 *
 * This module shipped with the HOURS and not the DAYS, so it reported peak all
 * weekend. That is 14 of its 35 peak hours — **40% of everything it ever called
 * peak was wrong**, and wrong in the expensive direction: it told an operator to
 * wait for a discount that was already applied. `console/lib/price-map.ts`
 * (`DEEPSEEK_PEAK.days`) always had the day list; this copy did not, which is the
 * usual shape of the bug — the same fact written twice, corrected once.
 *
 * ⚠️ AND IT IS NOW WRITTEN **THREE** TIMES: here, `console/lib/price-map.ts`
 * (`DEEPSEEK_PEAK`) and `acuvo-code/lib/rate-card.mjs` (`PEAK_SCHEDULE`). All
 * three agree today. They should be ONE export — this file is the natural home,
 * since it has no dependencies — but `rate-card.mjs` was mid-flight when this
 * landed, and importing an in-flight module to save six lines would trade a
 * duplicated constant for a broken CLI warning. Reconcile deliberately, not as a
 * side effect.
 *
 * ⚠️ AND IT IS A **UTC** WEEKDAY. `getDay()` answers a different question: at
 * 01:30 UTC on a Saturday, a machine in AEST (UTC+10) is already in Saturday
 * *morning* and agrees by luck, but the same instant in New York (UTC−4) is
 * Friday evening and `getDay()` returns 5 → peak, on a day DeepSeek does not
 * charge peak. The window is published in UTC; every part of the test must be.
 */

/** DeepSeek's peak windows, in UTC hours: `[startInclusive, endExclusive)`. */
export const PEAK_WINDOWS = Object.freeze([
  Object.freeze([1, 4]),
  Object.freeze([6, 10]),
]);

/**
 * The UTC weekdays peak applies to — Monday(1) … Friday(5), per `getUTCDay()`.
 *
 * ⚠️ Written out rather than expressed as `day >= 1 && day <= 5`, because the
 * range form quietly assumes Sunday is 0 AND that the peak days are contiguous.
 * A list survives the day DeepSeek adds Saturday.
 */
export const PEAK_DAYS_UTC = Object.freeze([1, 2, 3, 4, 5]);

/** Peak pricing is exactly double off-peak on both input and output. */
export const PEAK_MULTIPLIER = 2;

/**
 * Is this moment inside a peak window?
 *
 * ⚠️ DAY FIRST, THEN HOUR. Two thirds of a weekday is off-peak and *all* of a
 * weekend is; getting the hour right and the day wrong is not a smaller version
 * of the same answer, it is a confident wrong one for 29% of the week.
 *
 * @param at a Date; injected rather than read from the clock so it is testable
 */
export function isPeak(at = new Date()) {
  if (!PEAK_DAYS_UTC.includes(at.getUTCDay())) return false;
  const hour = at.getUTCHours();
  return PEAK_WINDOWS.some(([from, to]) => hour >= from && hour < to);
}

/**
 * Minutes until off-peak billing resumes, or 0 when already off-peak.
 *
 * ⚠️ MINUTES, NOT HOURS. "About 4 hours" is the shape of answer that gets
 * ignored; "17 minutes" is the shape that changes a decision — and the gap
 * between them is exactly the case where waiting is obviously worth it.
 */
export function minutesToOffPeak(at = new Date()) {
  if (!isPeak(at)) return 0;
  const hour = at.getUTCHours();
  const window = PEAK_WINDOWS.find(([from, to]) => hour >= from && hour < to);
  const minutesIntoHour = at.getUTCMinutes() + at.getUTCSeconds() / 60;
  return Math.ceil((window[1] - hour) * 60 - minutesIntoHour);
}

/**
 * What a run costs now, and what it would cost off-peak.
 *
 * @param usdOffPeak the run's estimated cost at off-peak rates
 */
export function priceNow(usdOffPeak, at = new Date()) {
  const base = Number(usdOffPeak);
  if (!Number.isFinite(base) || base < 0) {
    return { ok: false, error: 'an estimate is required to price a run' };
  }
  const peak = isPeak(at);
  return {
    ok: true,
    peak,
    usd: peak ? base * PEAK_MULTIPLIER : base,
    usdOffPeak: base,
    saving: peak ? base * (PEAK_MULTIPLIER - 1) : 0,
    minutesToOffPeak: minutesToOffPeak(at),
  };
}

/**
 * The one line an operator should see before starting an expensive run.
 *
 * ⚠️ SILENT WHEN OFF-PEAK. A warning that prints every time is a warning nobody
 * reads, and two thirds of the day is off-peak — saying "billing is normal" is
 * noise that trains people to skip the line that matters.
 *
 * ⚠️ AND IT NAMES A THRESHOLD RATHER THAN NAGGING. Doubling four cents is not
 * worth anybody's attention; doubling six dollars is.
 */
export function peakWarning(usdOffPeak, { at = new Date(), minUsd = 0.5 } = {}) {
  const p = priceNow(usdOffPeak, at);
  if (!p.ok || !p.peak || p.usdOffPeak < minUsd) return null;
  const wait = p.minutesToOffPeak;
  return `⚠ DeepSeek peak billing is active (01:00-04:00 / 06:00-10:00 UTC, Mon-Fri). `
    + `This run is about $${p.usd.toFixed(2)} now, $${p.usdOffPeak.toFixed(2)} off-peak — `
    + `$${p.saving.toFixed(2)} more for starting now. Off-peak resumes in ${wait} minute${wait === 1 ? '' : 's'}.`;
}
