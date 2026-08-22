/**
 * ── ⭐⭐⭐ STOP NEEDING TO SEND 63 SCHEMAS ────────────────────────────────────
 *
 * Roman, 2026-08-20, on our own 100% cache number: *"a high-90s hit rate usually
 * means your software is sending the exact same large prompt over and over."*
 *
 * ⚠️ HALF WRONG AND HALF EXACTLY RIGHT, and the right half is this file. The
 * tool block MUST be re-sent every round — that is how chat-completions work,
 * not redundancy anyone chose — so caching it is the correct fix. But caching
 * makes 14,213 tokens *cheap*, not *free*: a cached read is still billed at
 * roughly a tenth, and it still occupies the context window, which is the
 * resource no cache refunds.
 *
 * MEASURED TODAY: `toolNamesForRounds` varies the offer by ROUND BUDGET and
 * nothing else — 47 tools at every budget above one. So "fix this typo" carries
 * the identical ~12k-token surface as "refactor the auth system".
 *
 * ⭐ THE EVIDENCE THIS IS WORTH DOING: adaptive shortlisting measured **93.1% vs
 * 87.1%** overall and **76.8% vs 60.9%** on medium-difficulty queries against a
 * fixed offer. Fewer, better-chosen tools beat more tools.
 *
 * ⚠️⚠️ AND THE FAILURE MODE THAT MAKES NAIVE SHORTLISTING WORSE THAN NOTHING:
 * withholding a tool the task actually needed. This repo has already measured
 * that **tool search fails on PARAPHRASE, not ranking** — a user who says
 * "commit this" and one who says "save my work to version control" are the same
 * intent and only one matches a keyword. So the design here is deliberately not
 * a classifier:
 *
 *   1. a CORE set is ALWAYS offered — the spine of any coding task;
 *   2. optional groups are ADDED on signal, never subtracted;
 *   3. ⭐ and the moment the model reaches for something it was not given, the
 *      next round gets EVERYTHING. Widening is automatic and permanent for the
 *      session, so the worst case is one wasted round rather than a task the
 *      agent cannot finish.
 *
 * That third rule is what makes this safe to ship. A shortlist you cannot escape
 * is a capability ceiling; a shortlist that opens the moment it is wrong is an
 * optimisation.
 */

/**
 * The spine. Every one of these is reachable from almost any coding task, and
 * the cost of withholding one is a failed run.
 *
 * ⚠️ GENEROUS ON PURPOSE. The saving comes from the groups below, which are
 * large and specialised; shaving the core would buy little and risk much.
 */
export const CORE_TOOLS = Object.freeze([
  'read_file', 'read_lines', 'read_around', 'list_dir', 'find_files', 'search_text',
  'write_file', 'write_files', 'edit_file', 'move_file', 'delete_file',
  'run_command', 'evaluate',
  'plan_start', 'plan_step', 'plan_status',
  'check_acceptance', 'declare_acceptance',
  'read_skill', 'remember', 'forget', 'ask_user', 'delegate',
]);

/**
 * Specialised groups, each with the words that mean "this task is about that".
 *
 * ⚠️ THE WORDS ARE A HINT, NOT A GATE. Missing one costs a single round because
 * of the widening rule; there is no need for them to be exhaustive, and pretending
 * they could be is how a keyword list becomes a capability ceiling.
 */
export const TOOL_GROUPS = Object.freeze({
  vcs: {
    tools: ['git_status', 'git_diff', 'git_log', 'git_commit', 'git_branch', 'git_push', 'gh_issue', 'gh_pr', 'gh_run'],
    words: ['git', 'commit', 'branch', 'merge', 'rebase', 'pr', 'pull request', 'push', 'issue', 'github', 'review', 'diff', 'changelog', 'version control', 'ci', 'workflow', 'release'],
  },
  process: {
    tools: ['start_process', 'stop_process', 'check_process', 'read_log', 'wait_for_output', 'summarize_log', 'call_endpoint'],
    words: ['server', 'dev server', 'run it', 'serve', 'port', 'localhost', 'api', 'endpoint', 'daemon', 'watch', 'log', 'logs', 'background', 'start', 'boot', 'listen'],
  },
  intel: {
    tools: ['check_types', 'find_definition', 'find_references', 'list_symbols', 'review_code'],
    words: ['type', 'types', 'typescript', 'tsc', 'refactor', 'rename', 'definition', 'reference', 'symbol', 'interface', 'signature', 'review', 'audit', 'lint'],
  },
  db: {
    tools: ['inspect_db', 'sample_db_rows'],
    words: ['database', 'db', 'sql', 'table', 'schema', 'query', 'postgres', 'sqlite', 'migration', 'row', 'rows'],
  },
  web: {
    tools: ['web_search', 'fetch_url', 'see_page'],
    words: ['search', 'docs', 'documentation', 'look up', 'website', 'url', 'http', 'scrape', 'fetch', 'browse', 'page', 'screenshot', 'render'],
  },
  media: {
    tools: ['generate_image', 'edit_image', 'expand_image', 'read_image', 'speak', 'transcribe', 'list_engines'],
    words: ['image', 'picture', 'photo', 'logo', 'icon', 'illustration', 'voice', 'speak', 'audio', 'speech', 'transcribe', 'video', 'render', 'design', 'visual'],
  },
  docs: {
    tools: ['make_document', 'read_document', 'read_table'],
    words: ['document', 'pdf', 'docx', 'spreadsheet', 'csv', 'excel', 'report', 'table', 'export'],
  },
  repl: {
    tools: ['repl', 'repl_reset', 'run_program'],
    words: ['repl', 'interactive', 'experiment', 'try', 'explore', 'inspect', 'debug', 'session', 'python', 'node script'],
  },
  session: {
    tools: ['list_sessions'],
    words: ['session', 'resume', 'earlier', 'previous run', 'last time', 'history'],
  },
});

const norm = (s) => String(s ?? '').toLowerCase();

/** Which groups a task's own words point at. */
export function groupsForTask(task) {
  const text = norm(task);
  if (!text.trim()) return Object.keys(TOOL_GROUPS);
  const hit = [];
  for (const [name, g] of Object.entries(TOOL_GROUPS)) {
    if (g.words.some((w) => text.includes(w))) hit.push(name);
  }
  return hit;
}

/**
 * The tools to offer for this task.
 *
 * @param {string} task the user's brief, verbatim
 * @param {readonly string[]} available what the environment actually allows —
 *   the shortlist may only ever be a SUBSET of this. Withdrawal (no shell, no
 *   browser, no key) has already been decided upstream and must not be undone
 *   here; a shortlist that re-offers a withdrawn tool is worse than no shortlist.
 * @param {{ widened?: boolean }} [opts] `widened` is set once the model has
 *   reached for something it was not given, and never unset for the session.
 */
export function shortlistTools(task, available, { widened = false } = {}) {
  const allowed = new Set(available ?? []);
  /**
   * ⚠️ WIDENED IS ABSOLUTE. Once the model has demonstrated the shortlist was
   * wrong, guessing again is how a run oscillates between two wrong offers.
   */
  if (widened) return [...allowed];

  /**
   * ⚠️ AN EMPTY OR VERY SHORT BRIEF OFFERS EVERYTHING. "fix it" carries no
   * signal, and a shortlist built from no evidence is a guess with consequences.
   */
  const text = norm(task);
  if (text.trim().length < 12) return [...allowed];

  const keep = new Set(CORE_TOOLS.filter((t) => allowed.has(t)));
  for (const name of groupsForTask(task)) {
    for (const t of TOOL_GROUPS[name].tools) if (allowed.has(t)) keep.add(t);
  }
  // `finish` and anything else the environment offers that we do not classify
  // stays IN — an unclassified tool is one we do not understand, and dropping
  // what you do not understand is how capability disappears quietly.
  for (const t of allowed) {
    if (!Object.values(TOOL_GROUPS).some((g) => g.tools.includes(t))) keep.add(t);
  }
  return [...allowed].filter((t) => keep.has(t));
}

/**
 * Did the model just reach for a tool it was not given? That is the signal to
 * widen — and it is a FACT, not a heuristic.
 */
export function shouldWiden(calledNames, offered) {
  const have = new Set(offered ?? []);
  return (calledNames ?? []).some((n) => typeof n === 'string' && n && !have.has(n));
}
