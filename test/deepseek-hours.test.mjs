/**
 * ── ⭐ THE BENCH IS OUR BIGGEST SPENDER AND SITS ON THE PEAK-EXPOSED PATH ────
 *
 * `directDeepSeek` is off by default because it is 3.7x dearer on output — but
 * the benchmark deliberately turns it ON (Roman: the OpenRouter balance is for
 * customers, a benchmark is our cost). So our own largest run pays double for
 * seven hours a day, and nothing anywhere said so.
 *
 * ⚠️ These tests pin the WINDOWS and the SILENCE. A warning that fires
 * off-peak, or on trivial amounts, is one nobody reads.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import {
  isPeak, minutesToOffPeak, priceNow, peakWarning, PEAK_MULTIPLIER, PEAK_DAYS_UTC,
} from '../lib/deepseek-hours.mjs';

/**
 * A fixed UTC moment, so none of this depends on when the suite runs.
 *
 * ⚠️ 2026-08-24 IS A MONDAY, and every hour-boundary test below leans on that.
 * The date used to be incidental; now it is load-bearing, so it is asserted.
 */
const utc = (h, m = 0) => new Date(Date.UTC(2026, 7, 24, h, m, 0));

/** The named weekdays the weekend tests turn on — stated, then proven. */
const FRI = '2026-08-21';
const SAT = '2026-08-22';
const SUN = '2026-08-23';
const MON = '2026-08-24';
const at = (day, hms) => new Date(`${day}T${hms}Z`);

test('⚠️ the fixture calendar is what it claims — a wrong anchor date fakes every result below', () => {
  assert.equal(utc(0).getUTCDay(), 1, '2026-08-24 must be a Monday');
  assert.equal(at(FRI, '00:00:00').getUTCDay(), 5);
  assert.equal(at(SAT, '00:00:00').getUTCDay(), 6);
  assert.equal(at(SUN, '00:00:00').getUTCDay(), 0);
  assert.equal(at(MON, '00:00:00').getUTCDay(), 1);
});

test('⭐ the two published windows, at their edges', () => {
  // 01:00-04:00
  assert.equal(isPeak(utc(0, 59)), false);
  assert.equal(isPeak(utc(1, 0)), true, '01:00 is the first peak minute');
  assert.equal(isPeak(utc(3, 59)), true);
  assert.equal(isPeak(utc(4, 0)), false, '04:00 is off-peak again');
  // 06:00-10:00
  assert.equal(isPeak(utc(5, 59)), false);
  assert.equal(isPeak(utc(6, 0)), true);
  assert.equal(isPeak(utc(9, 59)), true, '09:59 still bills double');
  assert.equal(isPeak(utc(10, 0)), false);
  // The long off-peak stretch.
  assert.equal(isPeak(utc(14, 30)), false);
  assert.equal(isPeak(utc(23, 0)), false);
});

test('⚠️⚠️ THE WEEKEND IS NEVER PEAK — 29% of the week, and it used to report double', () => {
  /**
   * The regression this pins: the module shipped with the HOURS and not the
   * DAYS. Two ledger records dated Saturday 2026-08-22 and Sunday 2026-08-23
   * were read as peak. Every hour below is a peak hour *on a weekday*, which is
   * the only way a day bug can show itself.
   */
  for (const hms of ['01:00:00', '01:30:00', '02:30:00', '03:59:59', '06:00:00', '09:00:00', '09:59:59']) {
    assert.equal(isPeak(at(SAT, hms)), false, `Saturday ${hms} read as peak`);
    assert.equal(isPeak(at(SUN, hms)), false, `Sunday ${hms} read as peak`);
    assert.equal(isPeak(at(MON, hms)), true, `Monday ${hms} read as off-peak`);
  }
});

test('⭐ Friday is a full peak day, and 23:59 Friday is not the start of a weekend exemption', () => {
  // Friday is IN the schedule — a `day < 5` off-by-one would drop it silently,
  // and dropping a peak day is the cheap-looking error that under-warns.
  assert.equal(isPeak(at(FRI, '01:00:00')), true, 'Friday 01:00 opens peak like any weekday');
  assert.equal(isPeak(at(FRI, '09:59:59')), true);
  // 23:59 Friday is off-peak for the ORDINARY reason (no window covers 23:00),
  // not because the weekend started. Both facts, one instant.
  assert.equal(isPeak(at(FRI, '23:59:59')), false);
  assert.equal(PEAK_DAYS_UTC.includes(5), true, 'Friday must be in the day list');
  assert.deepEqual([...PEAK_DAYS_UTC], [1, 2, 3, 4, 5], 'Mon-Fri, Sunday-is-0 convention');
});

test('⚠️ both edges of both windows, on a Saturday — all four are off-peak', () => {
  for (const hms of ['00:59:59', '01:00:00', '03:59:59', '04:00:00', '05:59:59', '06:00:00', '09:59:59', '10:00:00']) {
    assert.equal(isPeak(at(SAT, hms)), false, `Saturday ${hms}`);
  }
  // Monday 01:00 is the genuine article, so the assertions above are not
  // passing merely because isPeak has stopped answering yes at all.
  assert.equal(isPeak(at(MON, '01:00:00')), true);
});

test('⚠️⚠️ THE WEEKDAY IS UTC, NOT LOCAL — proven by re-running under two real timezones', () => {
  /**
   * This machine runs AEST (UTC+10), where a `getDay()` implementation agrees
   * with the correct answer BY LUCK for Saturday 01:30 UTC — local is Saturday
   * midday. So an in-process test can never catch the local-vs-UTC error here.
   * Two child processes can: New York (UTC-4) reads that instant as FRIDAY
   * evening, and Kiritimati (UTC+14) reads Sunday 09:00 UTC as MONDAY.
   */
  const modUrl = new URL('../lib/deepseek-hours.mjs', import.meta.url).href;
  const probe = `
    const { isPeak } = await import(process.env.ACUVO_TEST_MOD);
    const a = (s) => isPeak(new Date(s));
    process.stdout.write(JSON.stringify({
      satPeakHour: a('${SAT}T01:30:00Z'),   // Fri 21:30 in New York
      sunPeakHour: a('${SUN}T09:00:00Z'),   // Mon 23:00 in Kiritimati
      monPeakHour: a('${MON}T01:30:00Z'),   // Sun 21:30 in New York
      friPeakHour: a('${FRI}T09:00:00Z'),   // Sat 23:00 in Kiritimati
    }));
  `;
  for (const tz of ['America/New_York', 'Pacific/Kiritimati', 'UTC']) {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
      env: { ...process.env, TZ: tz, ACUVO_TEST_MOD: modUrl },
      encoding: 'utf8',
    });
    assert.deepEqual(JSON.parse(out), {
      satPeakHour: false,
      sunPeakHour: false,
      monPeakHour: true,
      friPeakHour: true,
    }, `wrong answers under TZ=${tz} — the day rule is reading the LOCAL calendar`);
  }
});

test('⚠️ the weekend answer flows all the way through — no wait, no saving, no warning', () => {
  // isPeak being right is worthless if the three things built on it disagree.
  assert.equal(minutesToOffPeak(at(SAT, '01:30:00')), 0, 'nothing to wait for at the weekend');
  assert.equal(minutesToOffPeak(at(SUN, '09:00:00')), 0);

  const sat = priceNow(6, at(SAT, '01:30:00'));
  assert.equal(sat.peak, false);
  assert.equal(sat.usd, 6, 'a weekend run is already at the off-peak price');
  assert.equal(sat.saving, 0, 'there is no saving to be had by waiting');

  // ⭐ THE ONE THAT COST SOMETHING: the only caller prints this string, and on a
  // weekend it advised waiting hours for a discount already applied.
  assert.equal(peakWarning(50, { at: at(SAT, '01:30:00') }), null);
  assert.equal(peakWarning(50, { at: at(SUN, '09:00:00') }), null);
  assert.ok(peakWarning(50, { at: at(MON, '09:00:00') }), 'but Monday 09:00 still warns');
});

test('⭐ minutes to off-peak is exact, because "about 4 hours" gets ignored', () => {
  assert.equal(minutesToOffPeak(utc(9, 43)), 17, '09:43 -> 17 minutes to 10:00');
  assert.equal(minutesToOffPeak(utc(1, 0)), 180, '01:00 -> a full three hours');
  assert.equal(minutesToOffPeak(utc(14, 0)), 0, 'already off-peak');
});

test('⭐ peak is exactly double, and the saving is the difference', () => {
  const p = priceNow(6, utc(7, 0));
  assert.equal(p.peak, true);
  assert.equal(p.usd, 6 * PEAK_MULTIPLIER);
  assert.equal(p.saving, 6);

  const off = priceNow(6, utc(14, 0));
  assert.equal(off.peak, false);
  assert.equal(off.usd, 6);
  assert.equal(off.saving, 0);
});

test('⚠️⚠️ SILENT off-peak — a warning that always fires is one nobody reads', () => {
  assert.equal(peakWarning(50, { at: utc(14, 0) }), null);
  assert.equal(peakWarning(50, { at: utc(23, 30) }), null);
});

test('⚠️ silent on trivial amounts — doubling four cents deserves nobody\'s attention', () => {
  assert.equal(peakWarning(0.04, { at: utc(7, 0) }), null);
  assert.ok(peakWarning(6, { at: utc(7, 0) }), 'six dollars doubling is worth saying');
});

test('⭐ the warning states both prices, the difference, and the wait', () => {
  const w = peakWarning(6, { at: utc(9, 43) });
  assert.match(w, /\$12\.00 now/);
  assert.match(w, /\$6\.00 off-peak/);
  assert.match(w, /\$6\.00 more/);
  assert.match(w, /17 minutes/);
});

test('⚠️ a nonsense estimate is refused rather than priced', () => {
  assert.equal(priceNow('soon').ok, false);
  assert.equal(priceNow(-5).ok, false);
  assert.equal(peakWarning(NaN, { at: utc(7, 0) }), null);
});

test('⚠️ it only ever ANSWERS — nothing here defers, queues or re-routes', async () => {
  /**
   * Deciding to wait four hours is the operator's call. A tool that silently
   * queues a job somebody wanted NOW is worse than one that states the price.
   */
  const mod = await import('../lib/deepseek-hours.mjs');
  const verbs = Object.keys(mod).filter((k) => typeof mod[k] === 'function');
  for (const v of verbs) {
    assert.doesNotMatch(v, /defer|queue|delay|wait|route|schedule/i, `${v} sounds like it acts`);
  }
});
