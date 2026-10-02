/**
 * ── ⭐ THE `/` COMMAND SURFACE ───────────────────────────────────────────────
 *
 * ⚠️ MEASURED 2026-08-16: `grep -c "'/'" lib/chat.mjs` → **0**. The interactive
 * session understood exactly four words (`exit`, `quit`, `:q`, `bye`) and
 * nothing else. Every rival terminal agent opens on a `/` menu, and the gap is
 * not cosmetic — it is the difference between a session that ADMITS what it can
 * do and one where every capability is a thing you had to read a README to know
 * about.
 *
 * ⭐ AND THE FEATURES WERE ALREADY THERE. `skills.mjs` discovers and loads
 * `.acuvo/skills/*.md` today; `mcp.mjs` connects servers today; the budget
 * ledger counts dollars today. `WHAT-NEEDS-TO-HAPPEN.md` item 14 closed the
 * half of this that was about `--help` text and left this half open with the
 * note *"chat.mjs has no slash handling at all"*. This is that half: the
 * capabilities do not change, only whether a person sitting at the prompt can
 * find them.
 *
 * ── ⚠️⚠️ DISCOVERABILITY IS THE POINT, SO AN UNKNOWN COMMAND IS THE FEATURE ──
 *
 * A `/` surface whose failure mode is `unknown command` has solved nothing: the
 * person who typed `/skill` did not need to be told they were wrong, they needed
 * to be told the word is `/skills`. `suggestCommands` exists for that one
 * sentence, and it is the reason this module has an edit distance in it.
 *
 * ── ⚠️⚠️ A LEADING SLASH IS NOT ALWAYS A COMMAND, AND GUESSING WRONG EATS THE
 *    USER'S SENTENCE ──────────────────────────────────────────────────────────
 *
 * `/etc/hosts is wrong, fix it` and `/usr/local/bin/node is the wrong version`
 * are ordinary tasks that begin with `/`. If a naive `line.startsWith('/')`
 * claimed them, the session would answer "unknown command /etc" and the
 * instruction would be gone — a check that fails correct work, which this
 * codebase has paid for four times in one day and written down.
 *
 * ⭐ THE DISCRIMINATOR IS CHEAP AND EXACT: a command is a single token with NO
 * further `/` and no `.` in it. Every absolute path a person would type has a
 * second slash or an extension; no command has either. So `/mcp` is a command,
 * `/etc/hosts` is a sentence, and neither has to be guessed at.
 *
 * ── PURE ────────────────────────────────────────────────────────────────────
 *
 * No filesystem, no clock, no model, no terminal. Everything about the outside
 * world — which skills exist, which MCP servers are configured, what this run
 * has cost — arrives through the `context` argument as plain data or as a
 * provider function the caller supplies. That is the same rule `repo-map.mjs`
 * and `diff-preview.mjs` are built on, and it is why every branch below is
 * reachable from a test with none of those things.
 */

/**
 * ⚠️ THE REGISTRY IS DATA, NOT A SWITCH STATEMENT, because `/help` has to be
 * generated FROM it. A hand-written help text is a second copy of the command
 * list, and the second copy is the one that goes stale — which is precisely the
 * failure `--help` had before item 14: the feature worked and nothing a person
 * would read mentioned it.
 */
import { searchSkills } from './skill-search.mjs';

export const SLASH_COMMANDS = Object.freeze([
  Object.freeze({ name: 'help', usage: '/help', summary: 'list these commands' }),
  Object.freeze({ name: 'skills', usage: '/skills [search <need> | show <name> | use <name> | <name>]', summary: 'list, search, read or load a skill into the next turn' }),
  Object.freeze({ name: 'mcp', usage: '/mcp', summary: 'the MCP servers this workspace is configured with, and their status' }),
  Object.freeze({ name: 'cost', usage: '/cost', summary: 'what this session has spent so far, and against which ceiling' }),
  Object.freeze({ name: 'model', usage: '/model', summary: 'which model is answering, and where that choice came from' }),
  Object.freeze({ name: 'clear', usage: '/clear', summary: 'forget the conversation so far and start the next turn cold' }),
  /**
   * ── ⭐⭐⭐ THREE COMMANDS THE CLI ALREADY HAD, AND THE PROMPT COULD NOT REACH ──
   *
   * ⚠️ MEASURED 2026-09-19 by typing them at the prompt: `/config`, `/approve`,
   * `/rewind`, `/doctor`, `/spend` and `/resume` all answered *"is not a
   * command"* — while `acuvo config`, `acuvo rewind` and `--approve` have all
   * worked from the command line for weeks. So the four questions this product
   * is BUILT AROUND were invisible from the one place a person actually sits,
   * the ASK-or-ACT mode was fixed for the life of a session, and the undo —
   * the thing you reach for at the exact moment something went wrong — cost you
   * the conversation, because the only way to it was to leave.
   *
   * ⭐ NONE OF THESE ARE NEW CAPABILITY. `describeFourQuestions` (rcfile.mjs),
   * `APPROVE_MODES` (diff-preview.mjs) and `readJournal`/`planRewind`/
   * `applyRewind` (checkpoint.mjs) are the SAME implementations `bin/acuvo.mjs`
   * calls; the providers below hand their output through. A second rendering of
   * a checkpoint listing would be a second opinion about what is on disk.
   *
   * ⚠️ AND `/approve` IS THE ONLY ONE THAT CHANGES ANYTHING. It is the mode
   * switch every rival terminal puts on a keystroke, and the run loop already
   * re-reads `approveMode` on every turn — so this needed a provider, not a
   * mechanism.
   */
  Object.freeze({ name: 'config', usage: '/config', summary: 'the four questions in force here — done, cost, ask-or-act, stuck — and who decided each' }),
  Object.freeze({ name: 'approve', usage: '/approve [mode]', summary: 'ASK or ACT before a write: auto, always, never. Bare, it says which is in force.' }),
  Object.freeze({ name: 'rewind', usage: '/rewind [id]', summary: 'undo what the agent did to your files. Bare, it lists the checkpoints.' }),
  /**
   * ── ⭐⭐⭐ THE LAST THREE DOORS, AND THE ASYNC DISPATCHER WAS NOT NEEDED ────
   *
   * ⚠️ MEASURED 2026-09-19 by typing them at the prompt (`printf '/doctor\n
   * /spend\n/resume\n' | node bin/acuvo.mjs`): all three answered *"is not a
   * command"* while `acuvo --doctor`, `acuvo spend` and `acuvo --resume` had
   * all worked from the command line for weeks. Same defect as `/config`,
   * `/approve` and `/rewind` above — a capability the product HAS and the one
   * place a person sits cannot reach.
   *
   * ── ⚠️⚠️ THE REASON THEY WERE LEFT OUT WAS A REAL CONSTRAINT AND A WRONG
   *    CONCLUSION ────────────────────────────────────────────────────────────
   *
   * The note left behind said: `runSlashCommand` is synchronous by contract and
   * this module is pure, `--doctor` does network probes, so closing this needs
   * an async dispatcher — which touches every existing slash test. The first
   * two facts are true. The conclusion does not follow, and MEASURING each of
   * the three separately is what shows why:
   *
   *     /spend    `summariseSpend(readAuditFiles(root))`  SYNC — plain fs
   *     /resume   `listSessions` · `resumeMessages`       SYNC — plain fs
   *     /doctor   `runDoctor`                             async — network
   *
   * ⭐ TWO OF THE THREE NEEDED NO ASYNC AT ALL. They needed a PROVIDER, exactly
   * as `/config`, `/approve` and `/rewind` did — `readJournal` behind `/rewind`
   * is the same shape of synchronous filesystem read. Making the dispatcher
   * async to serve them would have been a change with no cause.
   *
   * ⭐⭐ AND THE THIRD ONE ALREADY HAD ITS SEAM: `effect`. This module has shipped
   * `effect: 'clear'` and `effect: 'run'` since the day it was written, and they
   * exist for precisely this — *"returns a DESCRIPTION of what should happen, and
   * performs none of it"*, as `runSlashCommand`'s own contract puts it. `/doctor`
   * returns `effect: 'doctor'` and the loop in `chat.mjs`, which is ALREADY
   * async and already impure, awaits the probes. Nothing here holds a promise,
   * so the purity guarantee at the top of this file is untouched rather than
   * "replaced" — and the nine commands that did not need to change, did not.
   *
   * ⚠️ THE COST OF THE ALTERNATIVE, STATED SO NOBODY RE-OPENS IT: an async
   * `runSlashCommand` makes all nine existing commands return promises to serve
   * one that probes the network, forces every caller and every test to await,
   * and puts a promise-returning provider inside a module whose header rules
   * exactly that out. `effect` costs one case in one already-async loop.
   */
  Object.freeze({ name: 'doctor', usage: '/doctor', summary: 'check this machine — keys, network, MCP servers, tools — without leaving the session' }),
  Object.freeze({ name: 'spend', usage: '/spend', summary: 'what this WORKSPACE has cost across every run, not just this session' }),
  Object.freeze({ name: 'resume', usage: '/resume [id]', summary: 'carry an earlier run\'s conversation into this one. Bare, it lists them.' }),
  /**
   * ── ⭐ TWO READ-ONLY LISTINGS, FOR PARITY (2026-09-27) ────────────────────
   *
   * Claude Code has `/agents` and `/hooks` (code.claude.com/docs, read
   * 2026-09-27). Both are "what is configured HERE, and is it valid" — the
   * question a person asks right after dropping a file into `.acuvo/`. Same
   * shape as `/config`: the provider hands back lines; this module owns no
   * second rendering of what `agent-definitions.mjs` / `hooks.mjs` say.
   */
  Object.freeze({ name: 'agents', usage: '/agents', summary: 'the specialist agents delegate can use here (.acuvo/agents, .claude/agents)' }),
  Object.freeze({ name: 'hooks', usage: '/hooks', summary: 'the hooks configured here, per event — or the error that stops them loading' }),
  /**
   * ── ⭐⭐ THE PARITY SET (2026-09-28) ──────────────────────────────────────
   *
   * Read live off code.claude.com/docs/en/commands that day. Each is an
   * existing module reached from the prompt — see `lib/session-commands.mjs`.
   * `/init` and `/memory` are sync providers; `/review`, `/compact` and
   * `/context` are `effect`s because the loop owns git's promise and the
   * history. `/usage` and `/permissions` are the rival NAMES for `/cost` and
   * `/approve` — a person who types the name they know must not be told it
   * is not a command.
   */
  Object.freeze({ name: 'init', usage: '/init [--force]', summary: 'draft ACUVO.md (project memory) from what is on disk. Never overwrites.' }),
  Object.freeze({ name: 'memory', usage: '/memory', summary: 'the project memory file sent with every request, and what it says' }),
  Object.freeze({ name: 'review', usage: '/review [--local] [path]', summary: 'review the uncommitted git diff: free pattern scan, then a model review (--local skips it)' }),
  Object.freeze({ name: 'compact', usage: '/compact [tokens]', summary: 'shrink the conversation now — stale tool output stubbed, the cached opening kept' }),
  Object.freeze({ name: 'context', usage: '/context', summary: 'how many tokens the conversation carries, by role' }),
  Object.freeze({ name: 'usage', usage: '/usage', summary: 'same as /cost — what this session has spent' }),
  Object.freeze({ name: 'permissions', usage: '/permissions [mode]', summary: 'same as /approve — ASK or ACT before a write' }),
]);

/** Name → entry, built once. */
const BY_NAME = new Map(SLASH_COMMANDS.map((c) => [c.name, c]));

/**
 * ── ⭐⭐⭐ COMMANDS THE PROJECT WRITES ITSELF — `.acuvo/commands/<name>.md` ────
 *
 * ⚠️ MEASURED 2026-08-25, answering Roman's *"does it have crazy functionality
 * and options like you?"*: the honest answer was **six commands, all ours, and
 * no way for a user to add a seventh.** Every rival terminal agent lets a team
 * check a markdown file into the repo and type `/ship` — it is the single most
 * used customisation surface any of them has, and it was the one class of
 * functionality this CLI had NONE of. Skills were the near miss: they are
 * chosen by the MODEL, on its own judgement, mid-run. A command is chosen by
 * the PERSON, deliberately, at the prompt. A team that wants "when I type
 * /review, do exactly these nine things" could not express it.
 *
 * ── ⭐ IT COSTS ZERO HEAD BYTES, AND THAT IS WHY IT IS SHAPED THIS WAY ───────
 *
 * The measured lesson of this week is that anything added to the system prompt
 * is paid for on EVERY round of EVERY run forever. So no command body, no
 * command name and no catalogue of them goes anywhere near the preamble. The
 * body becomes the text of ONE user turn, only when somebody types it, and the
 * model is never told these exist. The cost of shipping this to a user who
 * writes no commands is exactly nothing.
 *
 * ── ⚠️⚠️ A BUILT-IN ALWAYS WINS, AND THE SHADOWED FILE IS ANNOUNCED ─────────
 *
 * Skills resolve the other way — the project beats the bundle — and copying
 * that rule here would be a real bug rather than a preference. `/help` and
 * `/cost` are the session's escape hatches; a file called `help.md`, checked in
 * by anyone, would silently replace the one command a stuck user reaches for.
 * So the six names below are RESERVED, and a file that collides with one is not
 * quietly dropped either — `/help` prints it under "shadowed", because a
 * command that exists on disk and never runs is precisely the invisible failure
 * this repository keeps paying for.
 *
 * ── ⚠️ ARGUMENTS ARE NEVER SILENTLY DISCARDED ──────────────────────────────
 *
 * `$ARGUMENTS` takes everything typed after the name; `$1`…`$9` take one word
 * each. But a body that mentions NEITHER still receives what the user typed,
 * appended under a labelled line — because `/review src/app.ts` where
 * `review.md` forgot the placeholder must not run as a bare `/review` while the
 * user watches the path they typed disappear.
 *
 * ── PURE, LIKE THE REST OF THIS FILE ────────────────────────────────────────
 *
 * No directory is read here. `context.commands()` returns the catalogue and
 * `context.loadCommand(name)` returns one body — both supplied by the caller,
 * which in `bin/acuvo.mjs` is `discoverSkills`/`loadSkill` pointed at a
 * different directory. That is deliberate assembly: the frontmatter parser, the
 * name normaliser, the duplicate-name refusal, the binary-file guard, the size
 * cap and the workspace containment check are ALREADY WRITTEN and already
 * tested in `skills.mjs`. Re-implementing any of them here would be a second
 * copy of a security boundary.
 */

/** The six names a project file may not take. Derived, never retyped. */
export const RESERVED_COMMAND_NAMES = Object.freeze(SLASH_COMMANDS.map((c) => c.name));

/** Where a project keeps them. Quoted in the help text and in the refusals. */
export const USER_COMMANDS_DIR = '.acuvo/commands';

/**
 * The project's commands, split into the ones that can run and the ones a
 * built-in is already using.
 *
 * ⚠️ NEVER THROWS AND NEVER PARTIALLY TRUSTS. A provider that is absent, that
 * returns a non-array, or that throws mid-session yields empty lists — the same
 * rule every other provider in this file follows. A `/help` that dies because
 * somebody's commands directory is unreadable is worse than one that omits it.
 *
 * @param {{ commands?: unknown }} context
 * @returns {{ usable: {name:string, description:string}[], shadowed: string[], wired: boolean }}
 */
export function userCommands(context = {}) {
  if (typeof context.commands !== 'function') return { usable: [], shadowed: [], wired: false };
  let found;
  try {
    found = context.commands();
  } catch {
    return { usable: [], shadowed: [], wired: false };
  }
  if (!Array.isArray(found)) return { usable: [], shadowed: [], wired: true };
  const usable = [];
  const shadowed = [];
  const seen = new Set();
  for (const entry of found) {
    const name = String(entry?.name ?? '').trim().toLowerCase();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    if (BY_NAME.has(name)) { shadowed.push(name); continue; }
    usable.push({ name, description: String(entry?.description ?? '').trim() });
  }
  return { usable, shadowed, wired: true };
}

/**
 * Put what the user typed into the body.
 *
 * ⭐ THE FALLBACK IS THE LOAD-BEARING HALF. See the header: a body with no
 * placeholder and a user who typed arguments is the case that would otherwise
 * lose them, and losing them is indistinguishable — from the user's seat — from
 * the command having ignored the instruction.
 *
 * ⚠️ `$1`…`$9` ARE SPLIT ON WHITESPACE, and a missing one becomes the empty
 * string rather than the literal `$3`. A template that renders `$3` into a
 * prompt is a template that asks the model what `$3` means.
 *
 * @param {string} body
 * @param {string} args
 * @returns {string}
 */
export function expandCommand(body, args) {
  const text = String(body ?? '');
  const raw = String(args ?? '').trim();
  const words = raw ? raw.split(/\s+/) : [];
  const usesAll = /\$ARGUMENTS\b/.test(text);
  const usesNumbered = /\$[1-9]\b/.test(text);
  let out = text.replace(/\$ARGUMENTS\b/g, raw);
  out = out.replace(/\$([1-9])\b/g, (_m, d) => words[Number(d) - 1] ?? '');
  if (raw && !usesAll && !usesNumbered) {
    out = `${out.replace(/\s+$/, '')}\n\nWhat I typed after the command: ${raw}`;
  }
  return out;
}

/**
 * Is this line an attempt at a command, and if so which?
 *
 * ⚠️ RETURNS `null` FOR A SENTENCE, and that is the load-bearing case — see the
 * header. A bare `/` is a sentence too (somebody hit a key), not a command with
 * an empty name.
 *
 * @returns {{ name: string, args: string } | null}
 */
export function parseSlash(line) {
  const raw = String(line ?? '');
  // ⚠️ NOT trimmed at the start: a leading space means the user is typing prose,
  // and " /help" is far more likely to be part of a sentence than a command.
  if (!raw.startsWith('/')) return null;
  const m = /^\/([A-Za-z][A-Za-z0-9-]*)(?:\s+([\s\S]*))?$/.exec(raw.replace(/\s+$/, ''));
  if (!m) return null;
  return { name: m[1].toLowerCase(), args: (m[2] ?? '').trim() };
}

/**
 * Levenshtein, capped.
 *
 * ⚠️ WRITTEN OUT RATHER THAN IMPORTED because this package has zero
 * dependencies and that is not negotiable. It runs over a six-item list against
 * one short word, so the O(n·m) table is free.
 */
export function editDistance(a, b) {
  const s = String(a);
  const t = String(b);
  if (s === t) return 0;
  if (s.length === 0) return t.length;
  if (t.length === 0) return s.length;
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= t.length; j += 1) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[t.length];
}

/**
 * The commands a typo probably meant.
 *
 * ⭐ A PREFIX COUNTS AS A MATCH AT ANY LENGTH, and that is not the same rule as
 * the distance one. `/s` is distance 5 from `skills` and would be suggested by
 * nothing, but it is obviously a person reaching for `/skills`; a prefix is the
 * commonest half-typed shape there is.
 *
 * ⚠️ AND AN EMPTY RESULT IS RETURNED HONESTLY rather than padded out with the
 * whole list. `/xyzzy` resembles nothing, and offering `/cost` for it is noise
 * that teaches people to ignore the suggestion line — at which point the real
 * suggestions stop working too.
 */
export function suggestCommands(name, { commands = SLASH_COMMANDS, maxDistance = 3 } = {}) {
  const want = String(name ?? '').toLowerCase();
  if (!want) return [];
  const scored = [];
  for (const c of commands) {
    if (c.name.startsWith(want) || want.startsWith(c.name)) { scored.push([0, c.name]); continue; }
    const d = editDistance(want, c.name);
    // Scaled to the word: one wrong letter in `mcp` is a bigger signal than one
    // wrong letter in `skills`, so a flat threshold over-suggests for short names.
    if (d <= Math.min(maxDistance, Math.max(1, Math.ceil(c.name.length / 2)))) scored.push([d, c.name]);
  }
  return scored.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1)).map((s) => s[1]);
}

/**
 * `/help`, generated from the registry so it can never fall out of date.
 *
 * ⚠️ THE PROJECT'S OWN COMMANDS ARE LISTED IN A SEPARATE BLOCK, not merged into
 * the first one. They are not ours, they are not on anyone else's machine, and
 * a user comparing their terminal with a colleague's needs to see at a glance
 * which half came from the repository they are standing in.
 */
export function helpLines({ commands = SLASH_COMMANDS, user = [], shadowed = [] } = {}) {
  /**
   * ⚠️ `exit` IS IN THE SAME COLUMN AS THE REST, and it is measured from the
   * same width rather than spelled with hand-counted spaces. A hand-aligned
   * line is a second copy of the column width; it looked right when it was
   * written and drifts the moment a command with a longer usage is added.
   */
  const rows = [...commands.map((c) => [c.usage, c.summary]),
    // ⚠️ THE SLASHED FORMS ARE LISTED BECAUSE THEY EXIST — `/exit` was refused
    // until 2026-09-07 while every other command here takes a slash, so it is
    // the obvious guess. An alias nobody is told about is half a fix.
    ['exit', 'end the session (also /exit, quit, bye, :q, Ctrl-D)']];
  const userRows = user.map((c) => [`/${c.name}`, c.description || `run ${USER_COMMANDS_DIR}/${c.name}.md`]);
  // One width across BOTH blocks, so the two lists read as one column.
  const width = [...rows, ...userRows].reduce((n, r) => Math.max(n, r[0].length), 0);
  const lines = [
    'Commands — type one at the prompt. Anything else is a task for the agent.',
    ...rows.map(([usage, summary]) => `  ${usage.padEnd(width)}  ${summary}`),
  ];
  if (userRows.length > 0) {
    lines.push(
      '',
      `This project's own commands (${USER_COMMANDS_DIR}/), sent as your next message:`,
      ...userRows.map(([usage, summary]) => `  ${usage.padEnd(width)}  ${summary}`),
    );
  }
  /**
   * ⭐ THE SHADOWED BLOCK IS THE WHOLE POINT OF RESERVING THE NAMES. Dropping
   * these silently would leave someone editing a file that can never run, which
   * is the failure mode this codebase has written down more than once.
   */
  if (shadowed.length > 0) {
    lines.push(
      '',
      `  ⚠️ ${shadowed.map((n) => `${USER_COMMANDS_DIR}/${n}.md`).join(', ')} `
        + `${shadowed.length === 1 ? 'is' : 'are'} SHADOWED — /${shadowed.join(', /')} `
        + `${shadowed.length === 1 ? 'is a built-in' : 'are built-ins'} and cannot be replaced. Rename the file to use it.`,
    );
  }
  if (userRows.length === 0 && shadowed.length === 0) {
    lines.push(
      '',
      `  Add your own: a markdown file at ${USER_COMMANDS_DIR}/<name>.md becomes /<name>.`,
      '  Its text is sent as your next message; $ARGUMENTS is whatever you typed after it.',
    );
  }
  return lines;
}

/**
 * ⚠️ EVERY PROVIDER IS OPTIONAL AND ITS ABSENCE IS AN ANSWER, NOT A CRASH.
 * `runChat` is called from one place today, but it is also the piece a test and
 * a future embedder drive directly. A `/cost` that throws because nobody wired
 * a ledger would take the whole session down over a status line.
 *
 * ⭐ AND "NOT WIRED UP HERE" IS PRINTED AS ITSELF rather than as an empty list.
 * An empty list means "you have no MCP servers", which is a claim; silence about
 * a provider that was never supplied is a different fact and the user needs the
 * difference.
 */
function unavailable(what) {
  return [`  ${what} is not available in this session.`];
}

function renderSkills(context, args) {
  if (typeof context.skills !== 'function') return { output: unavailable('The skill catalogue') };
  const found = context.skills() ?? [];
  if (!args) {
    if (found.length === 0) {
      return {
        output: [
          '  No skills found. A skill is a markdown file in .acuvo/skills/ with a',
          '  `name:` and `description:` at the top; drop one in and it is picked up',
          '  on the next turn — no restart, no registration.',
        ],
      };
    }
    const width = found.reduce((n, s) => Math.max(n, String(s.name).length), 0);
    return {
      output: [
        /**
         * ⚠️ NOT "in .acuvo/skills". Most of these ship INSIDE the CLI package;
         * naming a directory they are mostly not in sends a curious user to an
         * empty folder to look for the thing they can already see listed. The
         * count is true, the location was not.
         */
        `  ${found.length} skill${found.length === 1 ? '' : 's'} available` +
          ` (bundled with Acuvo, plus any in .acuvo/skills):`,
        ...found.map((s) => `    ${String(s.name).padEnd(width)}  ${s.description ?? ''}`.replace(/\s+$/, '')),
        '  /skills search <need> finds one · /skills show <name> reads it · /skills <name> loads it into the next turn.',
      ],
    };
  }
  /**
   * ⭐ THE SUBCOMMANDS (2026-09-30). `search` ranks by NEED through the shared
   * `skill-search.mjs` (the builder reads the same code), `show` prints a skill
   * without attaching it, `use` is the explicit spelling of `/skills <name>`.
   * A bare name still loads, so nothing anybody learned stops working.
   */
  const sub = /^(search|find|show|use)\s+([\s\S]+)$/i.exec(String(args).trim());
  if (sub && /^(search|find)$/i.test(sub[1])) {
    const hits = searchSkills(sub[2], found, { limit: 5, surface: 'cli' });
    if (!hits.length) return { output: [`  No skill matches "${sub[2]}". /skills lists them all.`] };
    return {
      output: [
        `  Skills for "${sub[2]}":`,
        ...hits.map((h) => `    ${h.name}  ${h.description}`.replace(/\s+$/, '')),
        `  /skills show ${hits[0].name} to read it · /skills use ${hits[0].name} to attach it.`,
      ],
    };
  }
  if (sub && /^show$/i.test(sub[1])) {
    if (typeof context.loadSkill !== 'function') return { output: unavailable('Reading a skill') };
    const shown = context.loadSkill(sub[2]);
    if (!shown?.ok) return { output: [`  ${shown?.error ?? `no skill called "${sub[2]}"`}`] };
    const meta = found.find((s) => s.name === shown.name) ?? {};
    return {
      output: [
        `  ${shown.name} · v${meta.version ?? '1'} · ${meta.appliesTo ?? 'both'}${meta.triggers?.length ? ` · triggers: ${meta.triggers.join(', ')}` : ''}`,
        ...String(shown.body ?? shown.text ?? '').split(/\r?\n/).map((l) => `  ${l}`),
        `  (printed only — /skills use ${shown.name} attaches it to your next message)`,
      ],
    };
  }
  if (sub && /^use$/i.test(sub[1])) args = sub[2].trim();
  if (typeof context.loadSkill !== 'function') return { output: unavailable('Loading a skill') };
  const loaded = context.loadSkill(args);
  if (!loaded?.ok) {
    const names = found.map((s) => String(s.name));
    const near = suggestCommands(args, { commands: names.map((n) => ({ name: n })) });
    return {
      output: [
        `  ${loaded?.error ?? `no skill called "${args}"`}`,
        ...(near.length > 0 ? [`  Did you mean: ${near.map((n) => `/skills ${n}`).join('  ')}`] : []),
      ],
    };
  }
  /**
   * ⭐⭐ IT IS QUEUED FOR THE NEXT TURN, NOT PRINTED AND FORGOTTEN. Printing the
   * skill to the terminal would look exactly like loading it and would do
   * nothing at all — the model never sees the terminal. `inject` is what makes
   * this verb real, and the sentence below is what stops the user believing
   * something happened that did not.
   */
  /**
   * ⚠️ `body` IS WHAT `loadSkill` ACTUALLY RETURNS — checked against
   * `lib/skills.mjs`, not assumed. `text` is accepted first only so a caller
   * that pre-renders with `formatSkillForModel` can pass one straight through.
   * Reading a field the producer does not emit is how a feature ships loading
   * an empty string and reporting success.
   */
  const text = typeof loaded.text === 'string' ? loaded.text : String(loaded.body ?? '');
  if (!text) {
    return { output: [`  Skill "${loaded.name ?? args}" loaded but is empty — nothing was attached.`] };
  }
  return {
    inject: text,
    output: [
      `  Loaded skill "${loaded.name ?? args}" (${text.length} characters).`,
      '  It is attached to your NEXT message, not to the ones already sent.',
    ],
  };
}

function renderMcp(context) {
  if (typeof context.mcp !== 'function') return { output: unavailable('MCP status') };
  const info = context.mcp() ?? {};
  const servers = Array.isArray(info.servers) ? info.servers : [];
  if (servers.length === 0) {
    /**
     * ⚠️⚠️ AN EMPTY LIST IS NOT ALWAYS "YOU HAVE NONE". `readMcpConfig` returns
     * no servers both when there is no config AND when the config failed to
     * parse. Collapsing the two tells a user whose `mcp.json` has a trailing
     * comma to go and write the file they already wrote — the wrong problem, in
     * the wrong file. Caught by its own test; the first version of this function
     * had exactly that bug.
     */
    if (info.source) return { output: [`  No MCP servers are usable — ${info.source}`] };
    return {
      output: [
        '  No MCP servers configured for this workspace.',
        '  Add them to .acuvo/mcp.json (or .mcp.json) under an `mcpServers` key.',
      ],
    };
  }
  const width = servers.reduce((n, s) => Math.max(n, String(s.name).length), 0);
  return {
    output: [
      `  ${servers.length} MCP server${servers.length === 1 ? '' : 's'}${info.source ? ` from ${info.source}` : ''}:`,
      ...servers.map((s) => {
        const bits = [String(s.name).padEnd(width), s.status ?? 'not connected'];
        if (s.transport) bits.push(s.transport);
        // ⚠️ A tool COUNT only when we actually have one. `0 tools` and "we never
        // connected, so we do not know" are different facts and must not share a
        // rendering — the first would read as a broken server.
        if (typeof s.tools === 'number') bits.push(`${s.tools} tool${s.tools === 1 ? '' : 's'}`);
        return `    ${bits.join('  ')}`;
      }),
    ],
  };
}

function renderCost(context) {
  if (typeof context.cost !== 'function') return { output: unavailable('Spend for this session') };
  const c = context.cost() ?? {};
  const spent = Number(c.spentUsd);
  if (!Number.isFinite(spent)) return { output: unavailable('Spend for this session') };
  const lines = [`  This session has spent $${spent.toFixed(6)}` + (typeof c.turns === 'number' ? ` over ${c.turns} turn${c.turns === 1 ? '' : 's'}.` : '.')];
  if (Number.isFinite(Number(c.limitUsd))) {
    const limit = Number(c.limitUsd);
    const left = Math.max(0, limit - spent);
    lines.push(`  Ceiling $${limit.toFixed(6)}${c.limitIsDefault ? ' (the default — nobody set one)' : ''}, $${left.toFixed(6)} left.`);
  }
  /**
   * ⚠️ THE CEILING IS PER SESSION AND SAYING SO MATTERS. `bin/acuvo.mjs` records
   * that this exact number was once handed out fresh every turn, so a forty-turn
   * conversation permitted forty times the agreed limit. A `/cost` that printed
   * only a turn's spend would put that misreading back in front of the user.
   */
  return { output: lines };
}

/**
 * ── `/config` — THE FOUR QUESTIONS, WITHOUT LEAVING THE SESSION ────────────
 *
 * ⚠️ THE PROVIDER RETURNS LINES, NOT DATA, AND THAT IS DELIBERATE HERE. Every
 * other renderer in this file owns its wording because nothing else renders the
 * same fact. This one does not: `describeFourQuestions` in `rcfile.mjs` already
 * prints exactly this block for `acuvo config`, including the precedence
 * sentence that file calls "the one sentence, in one place". Re-deriving the
 * layout here would put a second copy of it behind a `/`, and the two would
 * disagree the first time either moved.
 */
function renderConfig(context) {
  return renderLines(context, 'config', 'The configuration');
}

/** A provider that returns lines, rendered indented. Shared by /config, /agents, /hooks. */
function renderLines(context, key, what) {
  if (typeof context[key] !== 'function') return { output: unavailable(what) };
  let lines;
  try {
    lines = context[key]();
  } catch {
    return { output: unavailable(what) };
  }
  if (typeof lines === 'string') lines = lines.split('\n');
  if (!Array.isArray(lines) || lines.length === 0) return { output: unavailable(what) };
  // ⚠️ A BLANK LINE IS NOT INDENTED. Padding one produces two trailing spaces,
  // which a diff, a paste and half the terminals in use render as visible cruft.
  return { output: ['', ...lines.map((l) => (l ? `  ${l}` : ''))] };
}

/**
 * ── ⭐⭐ `/approve` — THE ONLY MODE SWITCH, AND IT WAS LAUNCH-ONLY ──────────
 *
 * ⚠️ READING IT IS HALF THE FEATURE. A person cannot decide whether to widen
 * the gate without being told which one they are behind, and until now the only
 * way to find out was to quit and run `acuvo config`. So a bare `/approve`
 * answers and changes nothing — the same rule `acuvo rewind` follows, for the
 * same reason: a verb that guesses what you meant is a verb that acts on a
 * guess.
 *
 * ⚠️ AND AN UNKNOWN MODE NAMES THE THREE rather than saying "invalid". The
 * words are `auto`, `always` and `never`, they are not guessable, and a refusal
 * that withholds them makes the user go and read a README mid-session.
 */
function renderApprove(context, args) {
  if (typeof context.approve !== 'function') return { output: unavailable('The approval mode') };
  const wanted = String(args ?? '').trim().toLowerCase();
  let state;
  try {
    state = context.approve(wanted || undefined);
  } catch (err) {
    return { output: [`  the approval mode could not be changed: ${String(err?.message ?? err)}`] };
  }
  if (!state || typeof state !== 'object') return { output: unavailable('The approval mode') };
  const modes = Array.isArray(state.modes) && state.modes.length > 0 ? state.modes : null;
  const menu = modes ? `  the modes are ${modes.join(', ')}.` : null;
  if (state.ok === false) {
    return {
      output: [
        `  ${state.error ?? `/approve ${wanted} is not a mode.`}`,
        ...(menu ? [menu] : []),
      ],
    };
  }
  if (!wanted) {
    return {
      output: [
        `  approve  ${state.mode}${state.source ? `  (${state.source})` : ''}`,
        ...(state.note ? [`  ${state.note}`] : []),
        ...(menu ? [`${menu} Type /approve <mode> to change it for the rest of this session.`] : []),
      ],
    };
  }
  /**
   * ⚠️ THE PREVIOUS VALUE IS PRINTED. "approve is now always" is the same
   * sentence whether it moved or not, and somebody who typed the mode they were
   * already in needs to know their keystroke did nothing.
   */
  return {
    output: [
      state.previous && state.previous !== state.mode
        ? `  approve  ${state.previous} → ${state.mode}, for the rest of this session.`
        : `  approve  ${state.mode} — already in force; nothing changed.`,
      ...(state.note ? [`  ${state.note}`] : []),
    ],
  };
}

/**
 * ── ⭐⭐ `/rewind` — THE UNDO, AT THE MOMENT YOU WANT IT ────────────────────
 *
 * ⚠️ BARE IT LISTS AND RESTORES NOTHING. `bin/acuvo.mjs` states the argument in
 * full and it is inherited whole: a verb that guesses which state you meant is
 * a verb that overwrites the wrong one.
 *
 * ⚠️ THERE IS NO `--force` HERE ON PURPOSE. `applyRewind` refuses any file YOU
 * edited after the run, and overriding that refusal throws away an edit the
 * user made by hand. That is a decision worth leaving the session for; typing
 * one more word at a prompt is not enough deliberation for it, and `acuvo
 * rewind <id> --force` is still exactly one command away.
 */
function renderRewind(context, args) {
  if (typeof context.rewind !== 'function') return { output: unavailable('The undo') };
  const wanted = String(args ?? '').trim().split(/\s+/)[0] ?? '';
  if (/^--/.test(wanted)) {
    return {
      output: [
        `  /rewind takes a checkpoint id, not a flag.`,
        `  ${wanted} is a command-line option — run \`acuvo rewind <id> ${wanted}\` outside the session.`,
      ],
    };
  }
  let result;
  try {
    result = context.rewind(wanted || null);
  } catch (err) {
    return { output: [`  the checkpoints could not be read: ${String(err?.message ?? err)}`] };
  }
  const lines = Array.isArray(result?.lines) ? result.lines : null;
  if (!lines || lines.length === 0) return { output: unavailable('The undo') };
  return { output: ['', ...lines.map((l) => (l ? `  ${l}` : ''))] };
}

/**
 * Turn `/<name> <args>` into the message the model is about to be sent.
 *
 * ⚠️ `effect: 'run'` IS NOT `inject`. `inject` PRIMES the next thing the user
 * types — right for `/skills`, where the skill is context for an instruction
 * that has not been given yet. A project command IS the instruction, so it goes
 * this turn. Reusing `inject` would have made `/ship` do nothing until the user
 * typed something else, which is a dead button wearing a working button's coat.
 *
 * ⚠️ AND AN EMPTY BODY IS REFUSED RATHER THAN SENT. A blank file would
 * otherwise become a paid round asking the model to act on nothing.
 */
function runUserCommand(entry, args, context) {
  if (typeof context.loadCommand !== 'function') return { output: unavailable(`Running /${entry.name}`) };
  let loaded;
  try {
    loaded = context.loadCommand(entry.name);
  } catch (err) {
    return { output: [`  /${entry.name} could not be read: ${String(err?.message ?? err)}`] };
  }
  if (!loaded?.ok) {
    return { output: [`  ${loaded?.error ?? `${USER_COMMANDS_DIR}/${entry.name}.md could not be read.`}`] };
  }
  const body = typeof loaded.text === 'string' ? loaded.text : String(loaded.body ?? '');
  const task = expandCommand(body, args).trim();
  if (!task) {
    return { output: [`  /${entry.name} is empty (${loaded.file ?? `${USER_COMMANDS_DIR}/${entry.name}.md`}) — nothing was sent.`] };
  }
  return {
    effect: 'run',
    task,
    output: [`  /${entry.name} → ${loaded.file ?? `${USER_COMMANDS_DIR}/${entry.name}.md`} (${task.length} characters), sent as this turn.`],
  };
}

/**
 * ── ⭐⭐ `/spend` — WHAT THIS WORKSPACE COST, NOT WHAT THIS SESSION COST ─────
 *
 * ⚠️ IT IS NOT `/cost` AND THE DIFFERENCE IS THE WHOLE POINT. `/cost` reads a
 * counter this process has been incrementing since it started; `/spend` reads
 * `.acuvo/audit/` — every run anyone has ever made in this directory, including
 * the forty one-shot `acuvo "…"` invocations that never opened a prompt. A user
 * asking "how much has this cost me" means the second one, and until now the
 * only way to it was to quit the session they were spending in.
 *
 * ⚠️ SYNCHRONOUS, LIKE `/rewind`. `summariseSpend(readAuditFiles(root))` is a
 * directory read and a parse — the same shape as `readJournal`. It needed a
 * PROVIDER, not an async dispatcher; see the registry note above.
 */
function renderSpend(context) {
  if (typeof context.spend !== 'function') return { output: unavailable('Spend for this workspace') };
  let result;
  try {
    result = context.spend();
  } catch (err) {
    return { output: [`  the audit log could not be read: ${String(err?.message ?? err)}`] };
  }
  const lines = Array.isArray(result?.lines) ? result.lines : null;
  if (!lines || lines.length === 0) return { output: unavailable('Spend for this workspace') };
  return { output: ['', ...lines.map((l) => (l ? `  ${l}` : ''))] };
}

/**
 * ── ⭐⭐⭐ `/resume` — THE ONE COMMAND THAT USED TO REQUIRE QUITTING ─────────
 *
 * ⚠️ THIS IS THE COMMAND WITH THE WORST OLD WORKFLOW OF THE THREE. `--resume`
 * is a LAUNCH flag: to carry an earlier conversation into the session you are
 * sitting in, you had to leave the session you are sitting in — which ends the
 * conversation you would have wanted to keep. Typing it is the natural reach,
 * and it answered "is not a command".
 *
 * ⭐ BARE IT LISTS AND RESTORES NOTHING, the same rule `/rewind` follows for the
 * same reason: the ids are timestamps nobody memorises, and a verb that picks
 * one for you picks the wrong conversation.
 *
 * ⚠️⚠️ WITH AN ID IT REPLACES THE HISTORY, AND THAT IS AN `effect`, NOT A PRINT.
 * `effect: 'resume'` carries the restored messages back to the loop in
 * `chat.mjs`, which owns `history` — exactly as `effect: 'clear'` has since this
 * file was written. Nothing is re-run and nothing is re-paid; the messages are
 * data the provider read off disk, so this function still touches no fs.
 *
 * ⚠️ AND IT SAYS WHAT IT THREW AWAY. Resuming discards the turns already taken
 * in THIS session, and a person who has been working for ten minutes must not
 * discover that by noticing the model has forgotten.
 */
function renderResume(context, args) {
  if (typeof context.resume !== 'function') return { output: unavailable('Earlier runs') };
  const wanted = String(args ?? '').trim().split(/\s+/)[0] ?? '';
  if (/^--/.test(wanted)) {
    return {
      output: [
        `  /resume takes a run id, not a flag.`,
        `  ${wanted} is a command-line option — run \`acuvo ${wanted}\` outside the session.`,
      ],
    };
  }
  let result;
  try {
    result = context.resume(wanted || null);
  } catch (err) {
    return { output: [`  the saved runs could not be read: ${String(err?.message ?? err)}`] };
  }
  const lines = Array.isArray(result?.lines) ? result.lines : null;
  if (!lines || lines.length === 0) return { output: unavailable('Earlier runs') };
  const rendered = ['', ...lines.map((l) => (l ? `  ${l}` : ''))];
  /**
   * ⚠️ THE MESSAGES ARE CHECKED, NOT ASSUMED. A provider that answers a bad id
   * with an error line and no `messages` must not produce an effect that swaps
   * the history for `undefined` — which would silently empty the conversation
   * while the terminal printed an error about something else.
   */
  if (!Array.isArray(result.messages) || result.messages.length === 0) return { output: rendered };
  return { effect: 'resume', messages: result.messages, output: rendered };
}

/**
 * ── ⭐⭐⭐ `/doctor` — THE ONLY ONE THAT NEEDED THE `effect` SEAM ────────────
 *
 * ⚠️ `runDoctor` PROBES THE NETWORK, so its provider is the one async thing any
 * command here wants. THIS FUNCTION STILL AWAITS NOTHING: it returns
 * `effect: 'doctor'`, and the loop in `chat.mjs` — already async, already the
 * owner of the output stream — calls the provider and prints. That is the same
 * contract `effect: 'clear'` and `effect: 'run'` have had since day one:
 * *"returns a DESCRIPTION of what should happen, and performs none of it."*
 *
 * ⭐ SO THE PURITY GUARANTEE AT THE TOP OF THIS FILE IS INTACT rather than
 * "replaced". Nothing below holds a promise, no provider is CALLED here, and
 * the nine commands that did not need to change did not change. The alternative
 * — an async `runSlashCommand` — makes all twelve return promises to serve one,
 * forces every caller and every test to await, and puts a promise-returning
 * provider inside a module whose header rules exactly that out.
 *
 * ⚠️ THE "CHECKING…" LINE IS NOT DECORATION. The probes take seconds; without
 * it the terminal is silent after a keystroke, which is indistinguishable from
 * a hang — and this is the command people type when they already suspect one.
 */
function renderDoctor(context) {
  if (typeof context.doctor !== 'function') return { output: unavailable('The doctor') };
  return {
    effect: 'doctor',
    output: ['  checking this machine — key, model chain, media engines, MCP servers, tools…'],
  };
}

/** `/init` — a sync provider that writes the file and returns what it did. */
function renderInit(context, args) {
  if (typeof context.init !== 'function') return { output: unavailable('/init') };
  const force = /(^|\s)--force(\s|$)/.test(String(args ?? ''));
  let result;
  try {
    result = context.init({ force });
  } catch (err) {
    return { output: [`  /init could not run: ${String(err?.message ?? err)}`] };
  }
  const lines = Array.isArray(result?.lines) ? result.lines : null;
  if (!lines || lines.length === 0) return { output: unavailable('/init') };
  return { output: lines.map((l) => (l ? `  ${l}` : '')) };
}

/** `/compact [tokens]` — the loop owns the history, so this only parses. */
function renderCompact(args) {
  const raw = String(args ?? '').trim().replace(/[,_]/g, '');
  if (!raw) return { effect: 'compact', targetTokens: null, output: ['  compacting the conversation…'] };
  const m = /^(\d+)(k?)$/i.exec(raw);
  if (!m) return { output: [`  /compact takes a token target (e.g. /compact 8000 or /compact 8k), not "${args}".`] };
  return { effect: 'compact', targetTokens: Number(m[1]) * (m[2] ? 1000 : 1), output: [`  compacting the conversation toward ~${args} tokens…`] };
}

function renderModel(context) {
  if (typeof context.model !== 'function') return { output: unavailable('The model name') };
  const m = context.model();
  if (!m) return { output: unavailable('The model name') };
  if (typeof m === 'string') return { output: [`  ${m}`] };
  return {
    output: [
      `  ${m.name ?? 'unknown'}${m.source ? `  (${m.source})` : ''}`,
      ...(m.note ? [`  ${m.note}`] : []),
    ],
  };
}

/**
 * Run one command.
 *
 * ⭐ RETURNS A DESCRIPTION OF WHAT SHOULD HAPPEN, and performs none of it. The
 * loop in `chat.mjs` owns the history and the output stream; this function owns
 * the wording. Keeping the two apart is what lets every command below be
 * asserted without a terminal.
 *
 * @returns {{ output: string[], effect?: 'clear'|'run'|'resume'|'doctor', task?: string, messages?: object[], inject?: string, unknown?: boolean }}
 */
export function runSlashCommand(parsed, context = {}) {
  const name = parsed?.name;
  const mine = userCommands(context);
  if (!BY_NAME.has(name)) {
    /**
     * ⭐ THE PROJECT'S COMMANDS ARE TRIED BEFORE "not a command", and they are
     * also in the suggestion pool. A typo'd `/shp` must be answered with the
     * team's own `/ship`, not with the six built-ins it does not resemble.
     */
    const own = mine.usable.find((c) => c.name === name);
    if (own) return runUserCommand(own, parsed?.args ?? '', context);
    if (mine.shadowed.includes(name)) {
      /** Unreachable in practice — `BY_NAME` caught it — but the two lists CAN drift. */
      return { output: [`  /${name} is a built-in; the file of the same name is ignored.`] };
    }
    const near = suggestCommands(name, { commands: [...SLASH_COMMANDS, ...mine.usable] });
    return {
      unknown: true,
      output: [
        `  /${name} is not a command.`,
        ...(near.length > 0
          ? [`  Did you mean ${near.map((n) => `/${n}`).join(' or ')}?`]
          : ['  /help lists everything this prompt understands.']),
      ],
    };
  }
  switch (name) {
    case 'help': return { output: helpLines({ user: mine.usable, shadowed: mine.shadowed }) };
    case 'skills': return renderSkills(context, parsed.args);
    case 'mcp': return renderMcp(context);
    case 'cost': return renderCost(context);
    case 'model': return renderModel(context);
    case 'clear': return {
      effect: 'clear',
      output: ['  Conversation cleared. The next turn starts with no history.'],
    };
    case 'config': return renderConfig(context);
    case 'approve': return renderApprove(context, parsed.args);
    case 'rewind': return renderRewind(context, parsed.args);
    case 'spend': return renderSpend(context);
    case 'resume': return renderResume(context, parsed.args);
    case 'doctor': return renderDoctor(context);
    case 'agents': return renderLines(context, 'agents', 'The agent list');
    case 'hooks': return renderLines(context, 'hooks', 'The hook list');
    case 'init': return renderInit(context, parsed.args);
    case 'memory': return renderLines(context, 'memory', 'The project memory');
    case 'review': return typeof context.review === 'function'
      ? { effect: 'review', args: parsed.args ?? '', output: ['  reading the git diff…'] }
      : { output: unavailable('Reviewing the diff') };
    case 'compact': return renderCompact(parsed.args);
    case 'context': return { effect: 'context', output: ['  the conversation, as the next request would carry it:'] };
    case 'usage': return renderCost(context);
    case 'permissions': return renderApprove(context, parsed.args);
    /**
     * ⚠️ UNREACHABLE BY CONSTRUCTION — `BY_NAME` is built from the same list the
     * switch covers. It is here because the two CAN drift: adding a registry
     * entry without a case would otherwise return `undefined` and crash the
     * session on a command that `/help` had just advertised.
     */
    default: return { output: [`  /${name} is listed but not implemented — that is a bug in ${'slash.mjs'}.`] };
  }
}
