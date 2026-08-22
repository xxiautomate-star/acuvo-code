/**
 * ── ⭐ SHELL COMPLETION, AND THE ONE WAY IT IS WORSE THAN HAVING NONE ────────
 *
 * A completion script is the only part of a CLI that makes a claim about the
 * tool while the tool is not running. Nothing checks it at runtime, nobody reads
 * it, and it keeps making that claim for as long as it sits in the user's
 * `~/.bashrc`. So the failure mode is not "TAB does nothing" — it is:
 *
 *     $ acuvo --no-auto-le<TAB>
 *     $ acuvo --no-auto-lease
 *     Unknown option --no-auto-lease. Run with --help.
 *
 * The shell taught them a flag we deleted, and the tool called them wrong for
 * typing what it offered. ⚠️ **A completion script that offers a flag we removed
 * is worse than no completion at all**, so `test/terminal-ergonomics.test.mjs`
 * takes the flags back OUT of the generated scripts and drives every one of them
 * through the real `parseArgv`. Behaviour, not a grep — see the header of
 * `test/cli-flags-parse.test.mjs` for the day a source-grep guard reported green
 * about a flag that did not work.
 *
 * ── ⚠️ THE SUBTLE CORRECTNESS BUG: COMPLETING A FLAG'S *VALUE* ───────────────
 *
 * The obvious implementation offers the flag list at every position. Then:
 *
 *     $ acuvo --model <TAB>   →   --dir
 *
 * and `--model --dir` is not a parse error here, because `cli-args.mjs` refuses
 * only values that begin with `--`… which `--dir` does, so it errors — but
 * `--holder --json` would sail through and record a lease holder called
 * "--json". Every value-taking flag therefore gets its own arm that offers
 * VALUES and returns, and a flag whose value we cannot guess (`--budget`,
 * `--issue`) offers *nothing at all* rather than falling through to the flags.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────
 *
 * ⚠️ `bin/acuvo.mjs` pre-parses five more flags of its own before `parseArgv`
 * ever sees the argv — `--doctor`, `--replay`, `--design`, `--task-audio`,
 * `--say` (bin/acuvo.mjs:85). They are real and they are not completed here,
 * because `parseArgv` answers "Unknown option" for all five and the drift test
 * above would (correctly) reject them. That is a split argument surface, not a
 * completion bug, and the fix belongs in `bin/`. Until it moves, `extraFlags`
 * lets the caller add them in one line without this file guessing.
 *
 * ⭐ PURE. Every function returns a STRING. No filesystem, no `$SHELL` sniffing,
 * no writing to a user's rc file — the script goes to stdout and the user
 * decides where it lands, which is also the only version of this that works
 * over ssh, in a Dockerfile, and under a package manager.
 *
 * ⚠️ IMPORTS `cli-args.mjs`, SO NOTHING IN `cli-args.mjs` MAY IMPORT THIS. The
 * flag descriptions are read out of `USAGE` precisely so they cannot drift from
 * the help text; wiring `acuvo completion <shell>` therefore belongs in `bin/`,
 * where the cycle does not exist. An ESM cycle here would fail as an undefined
 * `USAGE` at module-init — which reads as "the help text is empty", not as an
 * import problem.
 */

import { USAGE } from './cli-args.mjs';
import { TIERS } from './escalate.mjs';
import { selectableModels } from './acuvo-models.mjs';
import { CREATIVE_ENGINES } from './creative-engines.mjs';

/** The shells we emit. A name outside this set is refused by `completionScript`. */
export const SUPPORTED_SHELLS = Object.freeze(['bash', 'zsh', 'fish']);

/**
 * ⭐ THE SUBCOMMANDS ARE THE FIVE THE PARSER CLAIMS, AND NO MORE.
 * `leases` and `spend` come from `COMMANDS`; `verify`, `board` and `rewind` each
 * have their own clause in `parseArgv` because they take arguments. Anything
 * else a user types as a first word is a TASK, and offering it here would teach
 * people that acuvo has verbs it does not have.
 */
export const SUBCOMMANDS = Object.freeze([
  Object.freeze({ name: 'verify', description: 'Re-check a past claim by running it again. No model call.' }),
  Object.freeze({ name: 'rewind', description: 'Put your files back the way they were before a run.' }),
  Object.freeze({ name: 'leases', description: 'Who holds which file in this workspace, and since when.' }),
  Object.freeze({ name: 'spend', description: 'What runs in this workspace have cost.' }),
  Object.freeze({ name: 'board', description: 'The shared task list several terminals claim work from.' }),
]);

/**
 * ⭐ Sub-verbs, kept beside the subcommand that owns them. `board` is the only
 * one with any: `bin/acuvo.mjs:726` accepts `add` and `done`, and a bare `board`
 * lists. Offering a third verb here would produce
 * `unknown board command "…"` from a shell that promised it worked.
 */
export const SUBCOMMAND_VERBS = Object.freeze({
  board: Object.freeze(['add', 'done']),
});

/**
 * Which flags belong to which subcommand, for the shells that can express it.
 * Everything else is offered everywhere, which is what `parseArgv` actually
 * does — it has no per-command flag tables.
 */
export const SUBCOMMAND_FLAGS = Object.freeze({
  verify: Object.freeze(['--all', '--json']),
  rewind: Object.freeze(['--force', '--dry-run']),
  spend: Object.freeze(['--since', '--json']),
  leases: Object.freeze(['--json']),
  board: Object.freeze(['--json']),
});

const modelChoices = () => selectableModels().map((m) => m.name);

/**
 * ── THE FLAG TABLE ──────────────────────────────────────────────────────────
 *
 * ⚠️ WRITTEN OUT, NOT SCRAPED FROM `USAGE`. A list derived from help-text
 * formatting fails SILENTLY and completely: one changed indent and the regex
 * matches nothing, the script emits an empty flag list, and TAB quietly stops
 * working with no error anywhere. An explicit table fails LOUDLY instead —
 * the drift test names every flag that is documented and missing here.
 *
 * ⭐ Descriptions ARE scraped, because the failure mode is the opposite: a
 * missing description is cosmetic, and a description copied by hand is a second
 * place for the help text to be wrong.
 *
 * `value: null` = boolean. Otherwise `{ hint, choices?, complete? }`, where
 * `complete` is 'dir' | 'file' and `choices` is a closed set.
 */
const flag = (name, value = null, alias = null) => Object.freeze({ name, value, alias });

export const FLAGS = Object.freeze([
  flag('--help', null, '-h'),
  flag('--version', null, '-v'),

  flag('--dir', Object.freeze({ hint: 'directory', complete: 'dir' })),
  flag('--model', Object.freeze({ hint: 'model', choices: Object.freeze(modelChoices()) })),
  /**
   * ⭐ THE ENGINE CHOICE COMPLETES TO THE REAL IDS, and it is one line here
   * because the ids are the only part of an engine this package knows —
   * the CREDIT PRICE of each is an account fact the gateway serves, never
   * something a published npm package may carry. See creative-engines.mjs.
   *
   * ⚠️ Added by the engine-choice lane, whose `--engine` flag made
   * `every documented flag IS offered` go red the moment it was documented.
   */
  flag('--engine', Object.freeze({ hint: 'engine', choices: Object.freeze(CREATIVE_ENGINES.map((e) => e.id)) })),
  flag('--max-rounds', Object.freeze({ hint: 'rounds' })),
  flag('--max-tokens', Object.freeze({ hint: 'tokens' })),
  flag('--timeout', Object.freeze({ hint: 'seconds' })),
  flag('--command-timeout', Object.freeze({ hint: 'seconds' })),
  /**
   * ⭐ `none` IS OFFERED FIRST because it is the one value a user cannot guess.
   * A $0.02 ceiling is on by default (`budget.mjs:172`), and the only way back
   * to the old unbounded behaviour is a word, not a number.
   */
  flag('--budget', Object.freeze({ hint: 'usd', choices: Object.freeze(['none', '0.10', '0.50', '1.00', '5.00']) })),
  flag('--fleet-budget', Object.freeze({ hint: 'usd', choices: Object.freeze(['none', '1.00', '5.00', '20.00']) })),
  flag('--budget-window', Object.freeze({ hint: 'period', choices: Object.freeze(['24h', '7d', '30d']) })),
  flag('--since', Object.freeze({ hint: 'period', choices: Object.freeze(['24h', '7d', '30d']) })),
  flag('--lease', Object.freeze({ hint: 'file', complete: 'file' })),
  flag('--holder', Object.freeze({ hint: 'name' })),
  flag('--issue', Object.freeze({ hint: 'number' })),
  flag('--concurrency', Object.freeze({ hint: 'count', choices: Object.freeze(['1', '2', '3', '4']) })),
  flag('--best-of', Object.freeze({ hint: 'count', choices: Object.freeze(['2', '3', '4', '5']) })),
  /** ⚠️ FROM `TIERS`, never typed out — `cli-args.mjs:564` validates against the
   *  same array, and a completion offering a fourth tier would be offering a
   *  value the parser refuses by name. */
  flag('--max-tier', Object.freeze({ hint: 'tier', choices: TIERS })),

  flag('--parallel'),
  flag('--until-done'),
  flag('--json'),
  flag('--dry-run'),
  flag('--strict'),
  flag('--offline'),
  flag('--no-run'),
  flag('--no-auto-lease'),
  flag('--no-checkpoint'),
  flag('--force'),
  flag('--claim'),
  flag('--unattended'),
  flag('--refute'),
  flag('--all'),
  flag('--shell'),
  flag('--plan'),
]);

// ── descriptions, read out of the help text ────────────────────────────────

/**
 * Rows in `USAGE` look like one of:
 *
 *     "  --dir <path>          Workspace root (default: the current directory)."
 *     "  --command-timeout <s> Kill a command after this long (default: 120)."
 *     "  -h, --help            This."
 *
 * ⚠️ The middle one is why the separator is not simply `\s{2,}`: that row has a
 * SINGLE space after `<s>`, because the placeholder ate the column. Requiring
 * two spaces silently dropped exactly one description, which is the kind of bug
 * nobody ever reports.
 */
const DESCRIPTION_ROW = /^ {2}(-{1,2}[a-z][a-z0-9-]*)(?:,\s+(--[a-z0-9-]+))?(?:(?:\s+<[^>]*>\s+)|\s{2,})(\S.*)$/gm;

/**
 * @param {string} [usage]
 * @returns {Map<string, string>} flag spelling → its first line of help
 */
export function usageDescriptions(usage = USAGE) {
  const out = new Map();
  for (const m of String(usage ?? '').matchAll(DESCRIPTION_ROW)) {
    const desc = m[3].trim();
    if (m[1]) out.set(m[1], desc);
    if (m[2]) out.set(m[2], desc);
  }
  return out;
}

/**
 * ⚠️ A DESCRIPTION IS UNTRUSTED TEXT AS FAR AS THE SHELL IS CONCERNED. It comes
 * from `USAGE`, which is ours — but it contains backticks (`` `acuvo rewind` ``),
 * apostrophes, `$`, colons and brackets, and each of those breaks a DIFFERENT
 * one of the three shells: a backtick is command substitution in bash, an
 * apostrophe closes the single-quoted string it sits in, and `[`/`]`/`:` are the
 * field separators of a zsh `_arguments` spec. Generating a script that a user
 * SOURCES means a stray character is not a cosmetic bug.
 *
 * So the set is narrowed to something safe in all three rather than escaped
 * three different ways — one function to audit instead of three.
 */
export function safeDescription(text, max = 68) {
  let s = String(text ?? '');
  s = s.replace(/[`\\$"']/g, '');
  s = s.replace(/[[\]]/g, '');
  s = s.replace(/:/g, ' -');
  s = s.replace(/\s+/g, ' ').trim();
  /**
   * ⚠️ TRUNCATE AT A WORD BOUNDARY. A blind `slice` cuts a flag name in half,
   * and a description reading "…see --fleet-bud" puts a string that looks like a
   * flag and is not into a file whose whole job is to be right about flags.
   */
  if (s.length > max) {
    const cut = s.slice(0, max - 1);
    const space = cut.lastIndexOf(' ');
    s = `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
  }
  return s;
}

/** Every spelling the scripts should offer, aliases included. */
export function allFlagNames(extraFlags = []) {
  const names = [];
  for (const f of FLAGS) {
    if (f.alias) names.push(f.alias);
    names.push(f.name);
  }
  for (const extra of extraFlags) {
    const name = String(extra ?? '').trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * ── ⚠️ HAND-WRITTEN DESCRIPTIONS, FOR THE FLAGS `--help` DOES NOT DOCUMENT ───
 *
 * Four real, parseable flags have no row in `USAGE`: `-v`, `--strict`,
 * `--offline`, `--all` and `--since` (the last two are mentioned in prose but
 * not as rows). Leaving them described as "a flag" in three shells is worse
 * than writing the sentence.
 *
 * ⚠️ THIS IS A DRIFT SURFACE AND IT IS FENCED. The test asserts that no entry
 * here names a flag `USAGE` documents — so the day someone adds `--strict` to
 * the help text, the suite says "delete the fallback" instead of letting two
 * descriptions of one flag quietly disagree.
 *
 * ⭐ AND THE FENCE FIRED, 2026-08-19. `--version` was added to `USAGE` — it had
 * been parsed, working, and mentioned nowhere a person reads — and this test
 * immediately named the now-shadowed fallback. The entry below is deleted, so
 * the description a shell shows comes from the same string `--help` prints.
 * `-v` stays: it is a distinct name with no row of its own.
 */
const FALLBACK_DESCRIPTIONS = Object.freeze({
  '-v': 'Print the version and exit.',
  '--strict': 'Exit 1 if the run wrote nothing and ran nothing. Armed automatically in CI.',
  /**
   * ⚠️ THIS SENTENCE USED TO SAY "With --doctor: …" AND THE DRIFT TEST CAUGHT IT.
   * A description is pasted verbatim into the generated script, so a flag name
   * inside one is a flag the script appears to offer — and `--doctor` is parsed
   * by `bin/`, not by `parseArgv`, so zsh and fish were advertising a flag the
   * parser answers "Unknown option" to. Descriptions must not name flags.
   */
  '--offline': 'Skip every network probe when reporting what works here.',
  '--all': 'With acuvo verify: re-check every recorded claim, deduplicated by command.',
  '--since': 'With acuvo spend: only runs since this period.',
});

const describe = (name, descriptions) => safeDescription(descriptions.get(name) ?? FALLBACK_DESCRIPTIONS[name] ?? '');

/** Exported so the drift test can prove no fallback shadows a documented flag. */
export const fallbackDescriptions = () => ({ ...FALLBACK_DESCRIPTIONS });

const identifier = (command) => `_${String(command).replace(/[^A-Za-z0-9_]/g, '_')}`;

// ── bash ───────────────────────────────────────────────────────────────────

/**
 * @param {{ command?: string, extraFlags?: readonly string[] }} [opts]
 * @returns {string}
 */
export function bashCompletion({ command = 'acuvo', extraFlags = [] } = {}) {
  const fn = `${identifier(command)}_complete`;
  const flags = allFlagNames(extraFlags).join(' ');
  const subs = SUBCOMMANDS.map((s) => s.name).join(' ');

  const arms = [];
  const silent = [];
  for (const f of FLAGS) {
    if (!f.value) continue;
    const spellings = f.alias ? `${f.alias}|${f.name}` : f.name;
    if (f.value.complete === 'dir') {
      arms.push(`    ${spellings}) COMPREPLY=( $(compgen -d -- "$cur") ); return 0 ;;`);
    } else if (f.value.complete === 'file') {
      arms.push(`    ${spellings}) COMPREPLY=( $(compgen -f -- "$cur") ); return 0 ;;`);
    } else if (f.value.choices?.length) {
      arms.push(`    ${spellings}) COMPREPLY=( $(compgen -W "${f.value.choices.join(' ')}" -- "$cur") ); return 0 ;;`);
    } else {
      silent.push(spellings);
    }
  }
  /**
   * ⚠️ THIS ARM IS THE POINT OF THE WHOLE `case`. Without it, `--holder <TAB>`
   * falls through to the flag list and offers `--json` as a holder name.
   * Offering nothing is the honest answer for a value only the user knows.
   */
  if (silent.length) arms.push(`    ${silent.join('|')}) return 0 ;;`);

  const verbArms = Object.entries(SUBCOMMAND_VERBS).map(
    ([sub, verbs]) => `      ${sub}) COMPREPLY=( $(compgen -W "${verbs.join(' ')}" -- "$cur") ); return 0 ;;`,
  );

  return [
    `# ${command} completion for bash. Generated by \`${command} completion bash\`.`,
    `# Install:  ${command} completion bash > /etc/bash_completion.d/${command}`,
    `#    or:    ${command} completion bash >> ~/.bashrc`,
    '',
    `${fn}() {`,
    '  local cur prev',
    '  COMPREPLY=()',
    '  cur="${COMP_WORDS[COMP_CWORD]}"',
    '  prev="${COMP_WORDS[COMP_CWORD-1]}"',
    '',
    '  # A flag that takes a value completes the VALUE and stops. Falling through',
    '  # here would offer the flag list, and `--holder --json` is a lease held by',
    '  # something called "--json".',
    '  case "$prev" in',
    ...arms,
    '  esac',
    '',
    '  if [ "$COMP_CWORD" -eq 1 ]; then',
    `    COMPREPLY=( $(compgen -W "${subs} ${flags}" -- "$cur") )`,
    '    return 0',
    '  fi',
    '',
    '  if [ "$COMP_CWORD" -eq 2 ]; then',
    '    case "${COMP_WORDS[1]}" in',
    ...verbArms,
    '    esac',
    '  fi',
    '',
    `  COMPREPLY=( $(compgen -W "${flags}" -- "$cur") )`,
    '  return 0',
    '}',
    `complete -F ${fn} ${command}`,
    '',
  ].join('\n');
}

// ── zsh ────────────────────────────────────────────────────────────────────

/**
 * @param {{ command?: string, extraFlags?: readonly string[] }} [opts]
 * @returns {string}
 */
export function zshCompletion({ command = 'acuvo', extraFlags = [] } = {}) {
  const fn = identifier(command);
  const descriptions = usageDescriptions();

  const specs = [];
  const push = (name) => {
    const f = FLAGS.find((x) => x.name === name || x.alias === name);
    const d = describe(name, descriptions);
    const head = d ? `${name}[${d}]` : `${name}[a flag]`;
    if (!f?.value) { specs.push(`'${head}'`); return; }
    const { hint, choices, complete } = f.value;
    if (complete === 'dir') specs.push(`'${head}:${hint}:_files -/'`);
    else if (complete === 'file') specs.push(`'${head}:${hint}:_files'`);
    else if (choices?.length) specs.push(`'${head}:${hint}:(${choices.join(' ')})'`);
    // ⚠️ An EMPTY action, deliberately: zsh then completes nothing for this
    // value, which is right for a dollar amount or an issue number. An action
    // of `_default` would offer filenames, i.e. `--budget ./src`.
    else specs.push(`'${head}:${hint}:'`);
  };
  for (const name of allFlagNames(extraFlags)) push(name);

  const cmds = SUBCOMMANDS.map((s) => `    '${s.name}:${safeDescription(s.description)}'`);
  const verbCases = Object.entries(SUBCOMMAND_VERBS).map(
    ([sub, verbs]) => `        ${sub}) _values '${sub} command' ${verbs.map((v) => `'${v}'`).join(' ')} ;;`,
  );

  return [
    `#compdef ${command}`,
    `# ${command} completion for zsh. Generated by \`${command} completion zsh\`.`,
    `# Install:  ${command} completion zsh > "\${fpath[1]}/_${command}"`,
    '',
    `${fn}() {`,
    '  local state',
    '  local -a acuvo_cmds',
    '  acuvo_cmds=(',
    ...cmds,
    '  )',
    '',
    '  _arguments -s -S \\',
    ...specs.map((s) => `    ${s} \\`),
    "    '1:command or task:->acuvo_cmd' \\",
    "    '*::arguments:->acuvo_args'",
    '',
    '  case $state in',
    '    acuvo_cmd)',
    "      _describe -t commands 'acuvo command' acuvo_cmds",
    "      _message 'or the task to do, in quotes'",
    '      ;;',
    '    acuvo_args)',
    '      case $words[1] in',
    ...verbCases,
    '      esac',
    '      ;;',
    '  esac',
    '}',
    '',
    `compdef ${fn} ${command}`,
    '',
  ].join('\n');
}

// ── fish ───────────────────────────────────────────────────────────────────

/**
 * @param {{ command?: string, extraFlags?: readonly string[] }} [opts]
 * @returns {string}
 */
export function fishCompletion({ command = 'acuvo', extraFlags = [] } = {}) {
  const descriptions = usageDescriptions();
  const lines = [
    `# ${command} completion for fish. Generated by \`${command} completion fish\`.`,
    `# Install:  ${command} completion fish > ~/.config/fish/completions/${command}.fish`,
    '',
    // ⚠️ FIRST LINE OF BEHAVIOUR, NOT DECORATION. Without `-f`, fish completes
    // filenames for every argument of every flag, so `--budget <TAB>` offers the
    // contents of the directory. Files are re-enabled per flag with `-F`.
    `complete -c ${command} -f`,
    '',
  ];

  for (const s of SUBCOMMANDS) {
    lines.push(`complete -c ${command} -n '__fish_use_subcommand' -a '${s.name}' -d '${safeDescription(s.description)}'`);
  }
  for (const [sub, verbs] of Object.entries(SUBCOMMAND_VERBS)) {
    lines.push(`complete -c ${command} -n '__fish_seen_subcommand_from ${sub}' -a '${verbs.join(' ')}' -d 'a ${sub} command'`);
  }
  lines.push('');

  for (const f of FLAGS) {
    const d = describe(f.name, descriptions);
    const parts = [`complete -c ${command}`];
    if (f.alias) parts.push(`-s ${f.alias.replace(/^-/, '')}`);
    parts.push(`-l ${f.name.replace(/^--/, '')}`);
    if (f.value?.complete === 'dir') parts.push("-x -a '(__fish_complete_directories)'");
    else if (f.value?.complete === 'file') parts.push('-r -F');
    else if (f.value?.choices?.length) parts.push(`-x -a '${f.value.choices.join(' ')}'`);
    // `-x` = takes an argument AND no file completion for it. See the `-f` note.
    else if (f.value) parts.push('-x');
    if (d) parts.push(`-d '${d}'`);
    lines.push(parts.join(' '));
  }
  for (const extra of extraFlags) {
    const name = String(extra ?? '').trim();
    if (!name.startsWith('--')) continue;
    lines.push(`complete -c ${command} -l ${name.slice(2)}`);
  }

  lines.push('');
  return lines.join('\n');
}

// ── the one entry point ────────────────────────────────────────────────────

/**
 * @param {string} shell
 * @param {{ command?: string, extraFlags?: readonly string[] }} [opts]
 * @returns {{ ok: true, script: string } | { ok: false, error: string }}
 */
export function completionScript(shell, opts = {}) {
  const name = String(shell ?? '').trim().toLowerCase();
  if (!name) {
    return {
      ok: false,
      /**
       * ⚠️ NO `$SHELL` SNIFFING, AND THE REFUSAL SAYS SO. `$SHELL` is the LOGIN
       * shell, not the one you are typing into — a zsh user in a bash subshell
       * would be handed the wrong script and it would fail silently, which is
       * the one outcome a completion script must never produce. Naming the
       * shell costs one word and cannot be wrong.
       */
      error: `name the shell: ${SUPPORTED_SHELLS.map((s) => `${opts.command ?? 'acuvo'} completion ${s}`).join(' · ')}`,
    };
  }
  if (!SUPPORTED_SHELLS.includes(name)) {
    return { ok: false, error: `no completion for ${JSON.stringify(name)} — this emits ${SUPPORTED_SHELLS.join(', ')}. Pick the closest one; bash output works in any POSIX shell with bash-completion loaded.` };
  }
  if (name === 'bash') return { ok: true, script: bashCompletion(opts) };
  if (name === 'zsh') return { ok: true, script: zshCompletion(opts) };
  return { ok: true, script: fishCompletion(opts) };
}
