/**
 * ── ⭐⭐⭐ A GREETING PAYS 20,791 TOKENS, AND 42.8% OF IT IS A FILE TREE ──────
 *
 * Roman, 2026-08-29: *"I reckon it wastes a fuck ton of tokens in builder and
 * chat. We need to minimise this as much as possible… so it knows to use little
 * tokens for chatting."*
 *
 * MEASURED on the real path, `console/` (3,452 files), `maxRounds: 5`, the whole
 * round-1 wire (`appendOnlyWireBytes({tools, messages})`) for the task **"hi"**:
 *
 *     tool schemas       24,129 B   32.8%   ← the shortlist already cut this
 *     repo map           31,508 B   42.8%   ← THIS FILE
 *     skills catalogue   12,642 B   17.2%
 *     system prompt       4,464 B    6.1%
 *     the request itself      70 B    0.1%
 *     ─────────────────────────────────────
 *     TOTAL              73,935 B  ≈ 20,791 tokens for two characters
 *
 * ⚠️⚠️ THE BRIEF THAT SENT ME HERE MEASURED 27,763 B AND CALLED IT THE NUMBER
 * TO ATTACK. That is the tool block plus the system prompt — **37.5% of a
 * greeting**. The other 62.5% is the repo map and the skills catalogue, and
 * neither was in the frame. `test/head-cost-and-prefix.test.mjs` already
 * decomposed the head four ways and already named the map; the codebase knew
 * before the brief did.
 *
 * ── ⚠️⚠️⭐ THE TRAP, AND WHY IT DOES NOT BITE HERE ─────────────────────────
 *
 * `tool-shortlist.mjs`: *"a warm full block costs less than a half-cold
 * shortlisted one"* when the cached/uncached spread is wide. A payload that
 * varies per turn cannot sit in the cacheable prefix, so a naive "send less on
 * chat" change can COST money by voiding the prefix. That is TRUE OF THE TOOL
 * BLOCK. It is measurably NOT true of the repo map, for one structural reason:
 *
 *   ⭐ **THE MAP SITS BEHIND THE TOOL BLOCK ON THE WIRE, AND THE TOOL BLOCK HAS
 *   ALREADY DIVERGED.** Prefix caching is strictly sequential. Two different
 *   tasks get two different shortlists, so the wire diverges inside the tool
 *   schemas — and every byte after that point is cold no matter how identical it
 *   is. `turn.mjs` admits this in as many words: *"Shortlisting diverges inside
 *   the tool block, so everything behind it is cold."*
 *
 * MEASURED, full wire, `console/`, cross-task shared prefix:
 *
 *     pair                              A bytes   shared   Δ shared when A drops the map
 *     "hi" vs "build me a landing page"  73,935   24,048    0 B
 *     "hi" vs "analyse sales.csv"        73,935   24,048    0 B
 *     "analyse…" vs "build me a…"        79,461   24,088    0 B
 *
 * **Zero.** Not "small" — zero, on every cross-task pair. The 32,065 bytes come
 * off the payload and the shared prefix does not move by one byte.
 *
 * ⚠️ AND THE ONE CASE WHERE THE MAP *IS* A SHARED PREFIX — two conversational
 * turns in a row — LOSES NOTHING EITHER, because a warm byte is still a billed
 * byte at 1/15.7. Measured on the card in `ECONOMICS.md` (miss $0.44/M, hit
 * $0.028/M, 3.54 chars/token), `"hi"` then `"thanks"`:
 *
 *                            map ON        map OFF
 *     cold 1st turn        $0.00918966   $0.00520418   −43.4%
 *     warm 2nd turn        $0.00058576   $0.00033214   −43.3%
 *     cold bytes, 2nd turn        8 B            8 B    unchanged
 *
 * There is no case, warm or cold, cross-task or same-task, in which sending a
 * file tree to answer "hi" is cheaper than not sending one.
 *
 * ── ⚠️⚠️⭐ THE ESCAPE HATCH, BECAUSE THE MAP HAS NONE OF ITS OWN ────────────
 *
 * `tool-shortlist.mjs`'s third rule is what makes a shortlist safe: the moment
 * the model reaches for a verb it was not given, the offer widens permanently.
 * **A REPO MAP CANNOT BE REACHED FOR.** A model that is not shown a file tree
 * does not ask for one; it answers from nothing and the loss is silent — the
 * exact failure that file records for `find_symbol` and `start_process`
 * (*"a shortlist miss the escape hatch cannot catch is not a bounded one-round
 * cost, it is silent capability loss"*).
 *
 * So two defences, and they are both load-bearing:
 *
 *   1. ⭐ **THE MATCH IS A CLOSED LIST, NOT A CLASSIFIER.** Every entry in
 *      `CONVERSATIONAL` is a complete utterance that carries no work. A string
 *      either IS one of them after normalisation or it is not. `"fix it"` is
 *      short, carries no signal, matches no tool group — and does NOT match
 *      here, because it is an instruction. A keyword scorer would have taken it.
 *      `tool-shortlist.mjs` has recorded the paraphrase failure three times; the
 *      way to not repeat it is to not guess.
 *   2. ⭐ **THE SUPPRESSION ANNOUNCES ITSELF** (`NO_MAP_NOTE`, 108 B). If the
 *      turn turns out to need the tree, the model is told the verb that shows
 *      it. A bounded one-round cost, and a VISIBLE one — a round happens, which
 *      is the difference between this and silent loss.
 *
 * ⚠️ ANYTHING WITH A PATH, AN EXTENSION, A CODE FENCE OR A DIGIT IS NOT
 * CONVERSATIONAL, whatever else it looks like. `"hi"` is a greeting; `"hi, look
 * at app.tsx"` is a task that opens politely, and the guard below rejects it on
 * the dot rather than on the greeting.
 *
 * ── ⚠️⚠️⭐ THE RESULT HOLDS IN EVERY WIRE ORDER, AND CHECKING THAT FOUND A
 *    BIGGER PROBLEM THAT IS **NOT** FIXED HERE ─────────────────────────────
 *
 * ⚠️ FIRST, A CORRECTION TO THIS PACKAGE'S OWN INSTRUMENT. `cache-floor.mjs` is
 * called as `appendOnlyWireBytes({ tools, messages })` — tools FIRST — but the
 * real HTTP body is `{ model, messages, tools, ... }` (`model.mjs:1442`), so
 * **messages go out first.** The instrument is still correct for what it does
 * (round-to-round drift, same order both sides), but reading its output as
 * "where the provider's prefix diverges" is reading it as something it is not.
 *
 * The suppression was therefore re-measured under all three plausible orders,
 * `console/`, "hi" against "build me a landing page with a photo gallery":
 *
 *     order                          cross-task shared    with map   without
 *     tools → messages (instrument)                       24,048 B   24,048 B
 *     messages → tools (HTTP body)                         1,882 B    1,882 B
 *     system → tools → user (chat template)                1,826 B    1,826 B
 *
 * **Δ = 0 B in all three.** The saving does not depend on which order a
 * provider tokenizes, which is the only reason it is safe to ship without a
 * live call to settle the question.
 *
 * ⭐⭐ AND THE NUMBER THAT FELL OUT OF IT, WHICH IS WORTH MORE THAN THIS FILE:
 * under the two message-first orders the cross-task shared prefix is **1,826 of
 * 17,554 bytes — 10.4%**, and the divergence is inside the SYSTEM MESSAGE, at
 * byte 1,826, where `systemPrompt`'s offer-conditional paragraphs sit
 * (*"THE SHELL IS A TOOL FOR GETTING ANSWERS"* against *"DESIGN — YOU CAN LOOK
 * AT WHAT YOU BUILT"*). Behind them sit **15,730 bytes (89.6%) of completely
 * task-invariant text**, including the whole 12,642-byte skills catalogue.
 *
 * ⚠️ THAT IS THE `learnedBlock` DEFECT ONE LEVEL UP, AND IT IS STILL OPEN.
 * `turn.mjs` records the identical lesson and the identical fix: *"it diverged
 * at byte 408 of a 4,207-byte prefix and voided everything behind it — 9.7%
 * shared, versus 95.4% once it was moved to the end."* The offer-conditional
 * paragraphs need the same treatment; at 15,730 B ≈ 4,443 tokens, on the card
 * in `ECONOMICS.md` that is **$0.00183 per cross-task cold start, ~20% of a
 * greeting's entire input bill.**
 *
 * ⚠️⚠️ NOT DONE HERE, AND DELIBERATELY. Its value is real only if providers
 * tokenize messages before tools, and settling that needs one paid call —
 * OpenRouter has ~$6.65 and nothing was spent on this work. Reordering the
 * system prompt is also a large edit in a file with several lanes live. It is
 * written down rather than guessed at.
 */

/**
 * Complete utterances that ask for no work at all.
 *
 * ⚠️ EXACT MATCHES AFTER NORMALISATION — never substrings. `'ok'` as a substring
 * appears in "ok now rewrite the parser"; as a whole utterance it is an
 * acknowledgement. Substring matching is what would turn this closed list back
 * into the classifier it exists to avoid.
 *
 * ⚠️ IT IS SHORT ON PURPOSE AND SHOULD GROW SLOWLY. A wrong entry costs one
 * round on a real task; the saving from a marginal entry is one greeting. The
 * asymmetry says: add only what is unambiguously not a request.
 */
export const CONVERSATIONAL = Object.freeze([
  // greetings
  'hi', 'hii', 'hey', 'hello', 'yo', 'sup', 'hiya', 'hi there', 'hey there',
  'hello there', 'good morning', 'good afternoon', 'good evening', 'morning',
  'greetings', 'howdy',
  // acknowledgements and pleasantries
  'thanks', 'thank you', 'thanks!', 'ty', 'ta', 'cheers', 'nice', 'cool',
  'ok', 'okay', 'k', 'kk', 'got it', 'sounds good', 'perfect', 'great',
  'awesome', 'lovely', 'sweet', 'no worries', 'np', 'yep', 'yes', 'no', 'nope',
  'bye', 'goodbye', 'see ya', 'later', 'gn', 'good night',
  // meta questions about the agent itself — answered from the system prompt,
  // which is already in the payload. A file tree answers none of them.
  'who are you', 'what are you', 'what can you do', 'what do you do',
  'how are you', 'how do you work', 'what is this', 'what model are you',
  'are you there', 'you there', 'test', 'testing', 'ping',
]);

const SET = new Set(CONVERSATIONAL);

/**
 * ⚠️ PUNCTUATION IS STRIPPED, NOTHING ELSE IS. Lowercase, collapse whitespace,
 * drop trailing `.?!,` and a leading/trailing quote. No stemming, no stop-word
 * removal, no synonym expansion — every one of those turns a lookup back into a
 * guess.
 */
function normalise(task) {
  return String(task ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[.?!,;:]+$/g, '')
    .trim();
}

/**
 * ⚠️ THE HARD REJECTS, CHECKED BEFORE THE LIST. Any of these means the utterance
 * carries work even if its words look friendly, and each one is here because it
 * is cheap to detect and expensive to get wrong:
 *
 *   · `/` or `\`  — a path
 *   · a dot followed by letters — a filename or a package
 *   · a backtick or fence — code
 *   · a digit — a version, a line number, a count
 *   · `@` or `#`  — an issue, a handle, a scoped package
 *
 * A false NEGATIVE here costs 32 KB on one greeting. A false POSITIVE costs a
 * round on a real task and, worse, teaches nobody why. Fail toward sending the
 * map.
 */
const CARRIES_WORK = /[/\\`@#0-9]|\.[a-z]/i;

/**
 * Is this turn pure conversation — nothing that a file tree could help with?
 *
 * ⚠️ AN EMPTY TASK IS **NOT** CONVERSATIONAL, and that is the same rule
 * `shortlistTools` states for `''`: an empty brief is the ABSENCE of an
 * instruction (a resumed or continuing turn whose real request lives in history
 * this function never sees), not a short one. Narrowing there guesses from
 * evidence that exists and was not shown.
 *
 * @param {string} task the user's request, verbatim
 * @returns {boolean}
 */
export function isConversationalTurn(task) {
  const text = normalise(task);
  if (!text) return false;
  if (CARRIES_WORK.test(text)) return false;
  return SET.has(text);
}

/**
 * ⭐ THE ESCAPE HATCH, AND IT IS THE WHOLE REASON THIS IS SAFE TO SHIP.
 *
 * 108 bytes against 31,508 saved. It names the verb, so a turn that was
 * misjudged costs one `list_dir` round instead of an answer invented from
 * nothing — and that round is visible in the transcript, which is what stops
 * this becoming the silent capability loss `tool-shortlist.mjs` warns about.
 *
 * ⚠️ IT IS A SENTENCE, NOT A HEADING. `userPrompt` puts `contextText` above
 * `Task:` and the gather owns the shape of what it produced, so this has to read
 * as context rather than as an instruction competing with the task.
 */
export const NO_MAP_NOTE =
  'No workspace map was gathered for this turn (it looked conversational). '
  + 'If you need the file tree, call list_dir.';

/**
 * ── ⚠️⚠️⭐ THE ONE CASE WHERE THE TRAP *DOES* BITE, FOUND BY MUTATING FOR IT ─
 *
 * Everything above is measured with the tool shortlist ON, which is the default
 * since 2026-08-25. `turn.mjs` also documents the OFF switch and when to reach
 * for it: *"`ACUVO_TOOL_SHORTLIST=0` turns it off, and that is the switch to
 * reach for if `P` is ever measured above ~50%."*
 *
 * ⭐ WITH THE SHORTLIST OFF, EVERY TASK GETS THE SAME TOOL BLOCK — so nothing
 * diverges before the map, and the map becomes a genuine cross-task shared
 * prefix. Measured, `console/`, same pair as above:
 *
 *     shortlist   cross-task shared prefix   with map   without map     Δ
 *     ON                                      24,048 B     24,048 B      0 B
 *     OFF                                    101,535 B     77,954 B   −23,581 B
 *
 * ⚠️ THAT IS THE EXACT TRAP `tool-shortlist.mjs` WARNS ABOUT, surviving in a
 * narrow form: with the shortlist off, dropping the map on a chat turn destroys
 * 23,581 bytes of prefix that the next task in the same repository would have
 * read warm. So the suppression is gated on the same flag. **The saving exists
 * BECAUSE the shortlist already voided the prefix; where it has not, there is a
 * prefix to protect.**
 *
 * ⚠️⚠️ AND THIS IS A SECOND COPY OF A FLAG PARSE, WHICH IS THE COPY THAT GOES
 * STALE. `test/chat-turn-costs-less.test.mjs` reads `turn.mjs`'s source and
 * asserts the two accept the identical token set, so a change over there turns
 * this red instead of silently un-gating the suppression.
 */
const SHORTLIST_OFF = ['0', 'false', 'off', 'no'];

export function toolShortlistEnabled(env = process.env) {
  const flag = String(env?.ACUVO_TOOL_SHORTLIST ?? '').trim().toLowerCase();
  return !SHORTLIST_OFF.includes(flag);
}

/**
 * What `turn.mjs` puts in `context.text`.
 *
 * ⚠️ ONE FUNCTION, ONE CALL SITE, SO THE DECISION AND THE NOTE CANNOT DRIFT
 * APART. Two call sites is how a suppression ships without its escape hatch —
 * the shape of every silent-capability-loss entry in this package's history.
 *
 * @param {string} task
 * @param {() => string} gather the real map builder, called only when needed
 * @param {{ env?: object }} [opts]
 * @returns {{ text: string, suppressed: boolean }}
 */
export function contextTextForTurn(task, gather, { env = process.env } = {}) {
  if (toolShortlistEnabled(env) && isConversationalTurn(task)) {
    return { text: NO_MAP_NOTE, suppressed: true };
  }
  return { text: gather(), suppressed: false };
}
