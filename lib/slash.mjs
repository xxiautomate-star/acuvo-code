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
export const SLASH_COMMANDS = Object.freeze([
  Object.freeze({ name: 'help', usage: '/help', summary: 'list these commands' }),
  Object.freeze({ name: 'skills', usage: '/skills [name]', summary: 'list the skills in .acuvo/skills, or load one into the next turn' }),
  Object.freeze({ name: 'mcp', usage: '/mcp', summary: 'the MCP servers this workspace is configured with, and their status' }),
  Object.freeze({ name: 'cost', usage: '/cost', summary: 'what this session has spent so far, and against which ceiling' }),
  Object.freeze({ name: 'model', usage: '/model', summary: 'which model is answering, and where that choice came from' }),
  Object.freeze({ name: 'clear', usage: '/clear', summary: 'forget the conversation so far and start the next turn cold' }),
]);

/** Name → entry, built once. */
const BY_NAME = new Map(SLASH_COMMANDS.map((c) => [c.name, c]));

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

/** `/help`, generated from the registry so it can never fall out of date. */
export function helpLines({ commands = SLASH_COMMANDS } = {}) {
  /**
   * ⚠️ `exit` IS IN THE SAME COLUMN AS THE REST, and it is measured from the
   * same width rather than spelled with hand-counted spaces. A hand-aligned
   * line is a second copy of the column width; it looked right when it was
   * written and drifts the moment a command with a longer usage is added.
   */
  const rows = [...commands.map((c) => [c.usage, c.summary]),
    ['exit', 'end the session (also: quit, bye, :q, Ctrl-D)']];
  const width = rows.reduce((n, r) => Math.max(n, r[0].length), 0);
  return [
    'Commands — type one at the prompt. Anything else is a task for the agent.',
    ...rows.map(([usage, summary]) => `  ${usage.padEnd(width)}  ${summary}`),
  ];
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
        '  /skills <name> loads one into the next turn.',
      ],
    };
  }
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
 * @returns {{ output: string[], effect?: 'clear', inject?: string, unknown?: boolean }}
 */
export function runSlashCommand(parsed, context = {}) {
  const name = parsed?.name;
  if (!BY_NAME.has(name)) {
    const near = suggestCommands(name);
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
    case 'help': return { output: helpLines() };
    case 'skills': return renderSkills(context, parsed.args);
    case 'mcp': return renderMcp(context);
    case 'cost': return renderCost(context);
    case 'model': return renderModel(context);
    case 'clear': return {
      effect: 'clear',
      output: ['  Conversation cleared. The next turn starts with no history.'],
    };
    /**
     * ⚠️ UNREACHABLE BY CONSTRUCTION — `BY_NAME` is built from the same list the
     * switch covers. It is here because the two CAN drift: adding a registry
     * entry without a case would otherwise return `undefined` and crash the
     * session on a command that `/help` had just advertised.
     */
    default: return { output: [`  /${name} is listed but not implemented — that is a bug in ${'slash.mjs'}.`] };
  }
}
