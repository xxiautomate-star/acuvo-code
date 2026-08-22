/**
 * ── ⭐⭐ ONE COMPARATOR, BECAUSE THE PREFIX IS THE MARGIN ────────────────────
 *
 * Every list that gets rendered into a prompt has to sort the SAME WAY ON EVERY
 * MACHINE, or two workers on one repo send different bytes and share no prompt
 * cache at all. `repo-map.mjs` worked this out first and wrote the rule down —
 * "⚠️ NOT `localeCompare` — ICU differs per machine" — and then two other
 * modules sorted with `localeCompare` anyway.
 *
 * ⚠️ AND THEY WERE THE TWO THAT MATTER MOST. `learned.mjs` and `skills.mjs`
 * render into the system-message PREAMBLE, i.e. the very first bytes of every
 * prompt. `String.prototype.localeCompare` with no locale argument resolves
 * against the runtime's default locale and the Node build's ICU data (this
 * machine ships small-icu), so the same repo can render a different byte at
 * position 0 on two different machines — and a prefix cache is worth exactly
 * nothing past its first differing byte. That is precisely the configuration of
 * a multi-worker fleet, which is the case this project is built for.
 *
 * ⭐ THE FIX IS AN ORDERING CHANGE AND NOTHING ELSE. Code-point order is a
 * property of the strings, not of the environment: it is identical under
 * `LANG=C`, `LANG=en_US.UTF-8`, and on a full-ICU Node.
 *
 * ⚠️ IT IS NOT THE SAME ORDER AS `localeCompare`. Locale collation folds case
 * ('a' before 'B'); code points do not ('B' = 0x42 before 'a' = 0x61). That is a
 * visible change to how a catalogue reads, and it is the price of the ordering
 * being reproducible. Determinism wins: a catalogue whose order depends on who
 * is running it is not a catalogue.
 */

/** Code-point comparison. ⚠️ NOT `localeCompare` — ICU differs per machine. */
export function byCodePoint(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The same rule, reading one field off an object. */
export function byCodePointOn(key) {
  return (a, b) => byCodePoint(String(a?.[key] ?? ''), String(b?.[key] ?? ''));
}
