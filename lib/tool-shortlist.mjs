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
 *
 * ── ⭐⭐⭐ RE-MEASURED 2026-08-25 AGAINST `ECONOMICS.md`, AND TWO THINGS WERE
 *    WRONG — ONE IN THIS FILE, ONE IN HOW ITS OUTPUT IS *ORDERED* ────────────
 *
 * `ECONOMICS.md` decomposes a real recorded run whose task was the two
 * characters **"hi"**: tool schemas were **53.3% of the entire prompt** (48
 * tools, 48,469 chars) and **99.998% of what we paid for was overhead we sent
 * ourselves.** Cache-MISS input is 90.9% of the bill; output is 2.1%. So this
 * file is the largest single structural cost lever in the product.
 *
 * ⚠️ DEFECT 1 — THE SHORTLIST COULD NOT FIRE ON THE EXACT TASK THAT MOTIVATED
 * IT. Two independent gates were closed. `turn.mjs` reads
 * `ACUVO_TOOL_SHORTLIST`, which WAS off by default (it defaults ON as of
 * 2026-08-25, off only on an explicit 0/false/off/no); and even with it on,
 * the rule below returned EVERYTHING for any brief under 12 characters. "hi" is
 * two. Measured on this package's own offer: `shortlistTools('hi', offer)`
 * returned **49 of 49 tools, 50,075 bytes** — not one byte saved on the single
 * cheapest task we have ever run. See `NO_SIGNAL_OFFERS_THE_CORE` below.
 *
 * ⚠️⚠️ DEFECT 2 — AND IT IS NOT IN THIS FILE, SO IT IS RECORDED HERE RATHER
 * THAN FIXED HERE. `turn.mjs:2966` passes THIS FUNCTION'S PER-TASK OUTPUT to
 * `orderForCachePrefix` as the ordering key, which emits the shortlisted tools
 * first. That is exactly right for a WIDEN (the narrow block becomes a byte
 * prefix of the wide one — 100%) and exactly wrong for two DIFFERENT TASKS,
 * because each task's own groups are hoisted to the front of the block and
 * interleaved with the constant ones in registry order. Measured on this
 * package, two real briefs, `maxRounds: 5`:
 *
 *     ordering key            block A    block B   shared prefix   widen-append
 *     per-task (today)        29,408 B   31,243 B   8,418 B  28.6%     100.0%
 *     CORE_TOOLS (constant)   29,408 B   31,243 B  20,866 B  71.0%      75.7%
 *     no shortlist at all     50,075 B   50,075 B  50,075 B 100.0%     100.0%
 *
 * ⭐ A CONSTANT KEY IS THE RIGHT TRADE AND IT IS A ONE-LINE CHANGE: pass
 * `CORE_TOOLS` rather than the per-task list at `turn.mjs:2966`. A widen happens
 * at most once per session and only when the shortlist was wrong; a cross-task
 * cold start happens on every single run. 71% > 28.6%.
 *
 * ⭐⭐ AND BOTH CAN BE HAD AT ONCE, which is worth writing down because it needs
 * `tool-prefix.mjs`'s `rank()` to grow from two tiers to four:
 *
 *     0  core ∧ always-offered       constant for every task, every machine
 *     1  core ∧ machine-conditional  constant for every task on this machine
 *     2  task-selected groups        varies with the task  ← the variable part
 *     3  everything else             appended only on a widen
 *
 * Ranks 0–1 are then a byte-identical head for every task, and 0–2 are a byte
 * prefix of 0–3, so a widen still appends. Neither file is owned by this change.
 *
 * ⚠️⚠️ AND THE THING THAT MAKES ALL OF THIS CONDITIONAL: shortlisting is only a
 * saving on a COLD round. On the measured card (miss $0.44/M, hit $0.028/M — a
 * 15.7x spread) a warm full block costs less than a half-cold shortlisted one.
 * ECONOMICS §4 is what settles it: the prefix cache expires in minutes to hours,
 * so **round 1 is cold once per session for everybody**, 49 of 90 recorded runs
 * were 1–3 rounds, and for those round 1 is 89–100% of the input bill. Within a
 * session the task does not change, so the shortlisted block warms after round 1
 * exactly as the full one would. That is why this is worth doing — and why the
 * ordering key still has to be task-invariant for the fleet case.
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
  /**
   * ── ⭐⭐ THREE VERBS THAT WERE ALWAYS OFFERED AND WERE IN NO LIST ───────────
   *
   * MEASURED 2026-08-29: `find_symbol` (1,553 B), `apply_patch` (1,399 B) and
   * `pipe_to_asset` (2,341 B) were in the offer, in no `TOOL_GROUPS` entry and
   * not here — so the "keep what you do not understand" fallback at the bottom
   * of `shortlistTools` kept all three on EVERY task including "hi", 5,293 B a
   * round. That is the exact leak this file's header warns about and records
   * catching twice before (`chart` + `syndicate`, 2,852 B).
   *
   * ⚠️⚠️ AND ONLY ONE OF THE THREE WAS ACTUALLY FREE TO TAKE. The other two are
   * NAMED WHERE THE MODEL WILL READ THEM, and this package pins
   * *offered ⟺ named*:
   *
   *   · `apply_patch` is named IN `write_file`'S OWN DESCRIPTION — *"If the file
   *     ALREADY EXISTS, prefer apply_patch"* (`tools.mjs`). `write_file` is
   *     core, so it is offered on every task, so a task that reached it and
   *     found no `apply_patch` would be told to use a verb it had not been
   *     given — and `write_file` is what it would fall back to, which is the
   *     10-50x output cost that pointer exists to avoid.
   *   · `find_symbol` is positioned, deliberately, immediately before the search
   *     pair, and `tools.mjs` says why in as many words: *"a model hunting a
   *     definition should meet the index verb first and the grep second"*.
   *     `search_text` is core. Withholding `find_symbol` does not produce a
   *     widen — the model simply greps, which is the behaviour the verb exists
   *     to replace. ⚠️ A shortlist miss that the escape hatch cannot catch is
   *     not a bounded one-round cost; it is silent capability loss.
   *
   * ⭐ `pipe_to_asset` IS the free one and it moved to `media` — it generates an
   * image, nothing core names it, and a task that wants one says so.
   *
   * ⭐ Listing these here changes no offer today. It states the invariant, and
   * it puts them in the CONSTANT head that `orderForCachePrefix` builds from
   * `CORE_TOOLS` rather than leaving them to sort into the task-varying tail.
   */
  'find_symbol', 'find_usages', 'apply_patch',
  'write_file', 'write_files', 'edit_file', 'move_file', 'delete_file',
  /**
   * ⭐⭐ `check_tools` IS CORE FOR `find_symbol`'S REASON, NOT `run_command`'S.
   * Its 721 bytes buy back a whole round on any task in an ecosystem we do not
   * enable by default — measured across our own 139 bench runs, the model spent
   * 201 raw-shell `which` segments in 52 of them and was hard-refused
   * python3/pip/make/apt-get seven times. ⚠️ It cannot live in a keyword group:
   * a model that is not offered it does not reach for it, so there is no widen,
   * and the saving evaporates on exactly the unsignalled briefs where a wall is
   * discovered rather than announced.
   */
  'check_tools',
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
    /**
     * ⭐ `git_worktree` IS CLASSIFIED IN THE SAME COMMIT THAT DECLARES IT — the
     * rule this file states twice and has been burned by twice (`chart` +
     * `syndicate`, 2,852 B; then `find_symbol` + `apply_patch` + `pipe_to_asset`,
     * 5,293 B). An unclassified verb is KEPT by the fallback at the bottom of
     * `shortlistTools`, so it rides along on "hi" and is paid for on every
     * request of every task for ever. Here it costs 0 B on an unsignalled brief.
     */
    tools: ['git_status', 'git_diff', 'git_log', 'git_commit', 'git_branch', 'git_push', 'git_worktree', 'gh_issue', 'gh_pr', 'gh_run'],
    /**
     * ⚠️ 'worktree' AND 'isolat' ONLY — NOT 'parallel', NOT 'at once'. Those are
     * the words a task about isolation uses, and they are not words an ordinary
     * coding brief uses for anything else. 'parallel' is the tempting one and it
     * is wrong twice over: it is ordinary vocabulary ("parallelise this loop")
     * and it would drag ten vcs schemas into every task that said it.
     *
     * ⭐ THE MISS IS BOUNDED HERE IN A WAY `find_symbol`'S WAS NOT. That verb
     * had no widen because a model does not reach for something it has never
     * heard of; `git_worktree` is different — a model asked to run several
     * agents safely reaches for a worktree BY NAME, which is precisely the
     * signal `shouldWiden` turns into a permanent full offer.
     */
    words: ['git', 'commit', 'branch', 'merge', 'rebase', 'pr', 'pull request', 'push', 'issue', 'github', 'review', 'diff', 'changelog', 'version control', 'ci', 'workflow', 'release', 'worktree', 'isolat'],
  },
  process: {
    tools: ['start_process', 'stop_process', 'check_process', 'write_process', 'read_log', 'wait_for_output', 'summarize_log', 'call_endpoint'],
    /**
     * ── ⭐⭐⭐ THE JOB THAT BLOCKS LONGEST HAD NO WORD FOR ITSELF ─────────────
     *
     * ⚠️ EVERY WORD ON THIS LINE USED TO BE SERVER VOCABULARY — server, port,
     * localhost, daemon, listen. A compile, an `apt-get`, a `pip install` or a
     * training run matched NONE of them, and those are precisely the jobs that
     * outlast `run_command`'s ceiling. Measured on this package's own offer
     * 2026-08-29: **9 of 12 real build/install/compile/train briefs were offered
     * no background-process verb at all**, so the only tool left was
     * `run_command` and the only outcome a kill — 104 of them across 40 bench
     * transcripts, 57 at exactly the 120s default, and **24 of those 40 never
     * called `start_process`.** Those kills burned 319.7 minutes, 61.7% of all
     * command wall-clock in the archive, and produced zero exit codes.
     *
     * ⚠️⚠️ AND THE WIDEN ESCAPE CANNOT COVER THIS ONE. `shouldWiden` fires when
     * the model REACHES for a missing verb; `start_process`'s own schema told it
     * builds were out of scope (*"anything that does not exit on its own"*), so
     * it did not reach. A shortlist miss the escape hatch cannot catch is not a
     * bounded one-round cost — it is silent capability loss, exactly as this
     * file's header warns. `background.mjs` fixes the schema half; without these
     * words the verbs are still never offered, so neither half works alone.
     *
     * ⚠️ THE SHORTLIST HAS DEFAULTED ON ONLY SINCE 2026-08-25 — AFTER the last
     * bench run (2026-08-23). No transcript in the archive could have caught it.
     *
     * ⚠️⚠️ MORE WORDS HERE, NOT A SECOND GROUP, AND THAT WAS THE SECOND ATTEMPT.
     * A `longrun` group holding the six non-HTTP verbs would save `call_endpoint`'s
     * 2,202 B on a build — but `tool-shortlist.test` pins ONE TOOL, ONE GROUP
     * (*"its offer would depend on which words matched"*), and it went red
     * immediately. The invariant is worth more than the 2,202 B: a tool whose
     * offer depends on which of two word lists matched is a tool nobody can
     * reason about. A build pays the whole 9,587 B group.
     *
     * ⚠️ THE WORDS ARE SUBSTRING MATCHES AND WERE CHOSEN AGAINST THAT. No bare
     * 'apt' (inside "adaptive"), no bare 'pip' (inside "pipeline"), no bare
     * 'make' (inside "make sure"), no bare 'train' (inside "constraint"). Swept
     * against every brief the existing suite asserts on: none gains this group.
     */
    words: ['server', 'dev server', 'run it', 'serve', 'port', 'localhost', 'api', 'endpoint', 'daemon', 'watch', 'log', 'logs', 'background', 'start', 'boot', 'listen',
      'build', 'compile', 'cmake', 'makefile', 'make -j', 'run make', 'install', 'apt-get',
      'apt install', 'pip install', 'cargo', 'gradle', 'maven', 'bazel', 'training', 'train the',
      'epoch', 'download', 'benchmark', 'from source', 'tarball'],
  },
  /**
   * ⭐ `rename_symbol` JOINS `intel` RATHER THAN THE WRITE VERBS, and the words
   * needed no change — 'rename', 'refactor', 'symbol' and 'signature' were
   * already here, because they are the words that mean "this task is about what
   * the code MEANS". It belongs with the tools that share its gate: all six need
   * the same language server, so a brief that gets `find_references` and not
   * `rename_symbol` would be shown every call site and then told to edit them
   * by hand.
   */
  /**
   * ── ⭐⭐ THE THREE AST EDITS JOIN `intel` TOO, AND THAT DECISION IS NOT THE
   *        OBVIOUS ONE ──────────────────────────────────────────────────────
   *
   * They WRITE, so the tempting home is the write group beside `edit_file`. It
   * is wrong for the same reason `rename_symbol`'s note above gives: they share
   * a GATE with the navigation verbs — all nine need the project's own
   * `typescript` — and this package pins **offered ⟺ named-in-prompt**. A brief
   * that got `replace_function_body` without `find_definition` would be handed a
   * verb that edits a symbol and no verb that can find one.
   *
   * ⚠️ AND THE WORDS ALREADY POINT HERE. 'refactor', 'signature' and 'symbol'
   * are the words somebody types when they mean "change what this function
   * does", which is precisely `replace_function_body`. Adding 'insert' or
   * 'wrap' would drag six navigation schemas into every task that used the word
   * insert about a database row — the direction the `vercel_preview` note one
   * block down refuses for the same reason.
   */
  intel: {
    tools: ['check_types', 'find_definition', 'find_references', 'list_symbols', 'review_code', 'rename_symbol',
      'insert_before_symbol', 'insert_after_symbol', 'replace_function_body'],
    words: ['type', 'types', 'typescript', 'tsc', 'refactor', 'rename', 'definition', 'reference', 'symbol', 'interface', 'signature', 'review', 'audit', 'lint'],
  },
  db: {
    tools: ['inspect_db', 'sample_db_rows'],
    words: ['database', 'db', 'sql', 'table', 'schema', 'query', 'postgres', 'sqlite', 'migration', 'row', 'rows'],
  },
  /**
   * ⭐ `playtest` (1,882 B) JOINS `web` RATHER THAN GETTING ITS OWN GROUP: it
   * opens a page in a real browser and reports what is broken, which is the same
   * intent `see_page` serves and the same words point at it. A task that asks
   * for a page checked and is offered `see_page` but not `playtest` gets the
   * screenshot and not the console errors.
   */
  web: {
    tools: ['web_search', 'fetch_url', 'see_page', 'playtest'],
    words: ['search', 'docs', 'documentation', 'look up', 'website', 'url', 'http', 'scrape', 'fetch', 'browse', 'page', 'screenshot', 'render'],
  },
  /**
   * ⭐ A GROUP OF ONE, FOR THE REASON `content` IS A GROUP OF ONE. `vercel_preview`
   * (1,612 B) is a deploy, and the nearest existing home is `process` — but
   * putting it there would drag seven process schemas into every task that said
   * "deploy", and adding "deploy" to `process`'s words would do it in the other
   * direction. One tool, tight words, nothing dragged either way.
   *
   * ⚠️ The words are deliberately PHRASES where a single word would be ordinary
   * coding vocabulary. "preview" alone is what you do to a diff.
   */
  deploy: {
    tools: ['vercel_preview'],
    words: ['deploy', 'vercel', 'preview url', 'staging', 'go live', 'production url', 'hosting', 'ship it'],
  },
  /**
   * ⚠️ `viral` AND `podcast` ARE CLASSIFIED IN THE SAME COMMIT THAT DECLARES
   * THEM, for the reason the `docs` note below spells out: `shortlistTools`
   * KEEPS anything it cannot classify, so an unclassified verb rides along on
   * "hi" and is paid for on every request of every task forever. They join
   * `media` rather than getting a group of their own because their words are
   * already here — a request for a video or a voiceover is a media request, and
   * the tools they orchestrate (`generate_image`, `speak`) are in this group, so
   * a task that reaches one reaches all of them together anyway.
   */
  /**
   * ⭐ `pipe_to_asset` JOINS `media` — 2,341 B OFF EVERY UNSIGNALLED TASK, the
   * largest single item in the 5,293 B leak recorded on `CORE_TOOLS` above. It
   * is `generate_image` plus the edit that wires the result in, so it gates on
   * the same image configuration and every word that reaches one reaches it.
   *
   * ⚠️ AND IT WAS CONTRADICTING A TEST THAT ALREADY PASSED. `tool-shortlist.test`
   * asserts of "fix the failing type error in src/auth.ts" that *"a type error
   * needs no image generator"* — and an image generator was being offered on
   * that exact brief the whole time, under a different name.
   */
  media: {
    /**
     * ⭐ THE FIVE IDENTITY / RENDER VERBS JOIN TOO — 4,157 B THAT WAS LATENT
     * RATHER THAN ACTIVE. They are gated on media configuration this machine
     * does not have, so the leak was invisible here and real on any machine that
     * does: `clone_voice` 638 · `design_voice` 528 · `character_lock` 926 ·
     * `talking_head` 1,017 · `generate_video` 1,048. `test/tool-shortlist` now
     * sweeps ALL of `TOOL_NAMES` rather than this machine's offer, which is what
     * makes a leak that only fires elsewhere findable here.
     *
     * ⚠️ `design_voice` HAS TO BE IN THE SAME GROUP AS `viral`, and that is not a
     * preference: `viral`'s own description names it. Split across two groups,
     * a task could be offered `viral` and told to use a verb it did not have.
     */
    tools: ['generate_image', 'pipe_to_asset', 'edit_image', 'expand_image', 'read_image', 'speak', 'transcribe', 'list_engines', 'viral', 'podcast',
      'clone_voice', 'design_voice', 'character_lock', 'talking_head', 'generate_video', 'media_chain'],
    words: ['image', 'picture', 'photo', 'logo', 'icon', 'illustration', 'voice', 'speak', 'audio', 'speech', 'transcribe', 'video', 'render', 'design', 'visual',
      // ⚠️ Deliberately NOT 'short' or 'clip' — both are ordinary coding words
      // ("shorten this", "clip the array") and would drag seven media schemas
      // into every request that used one.
      // ⭐ The verbs' own names, exactly as `content` carries 'syndicate'. Asking
      // for "a viral short" and being offered everything EXCEPT `viral` is the
      // one shortlist miss a user would find absurd.
      'viral', 'podcast', 'voiceover', 'narration', 'subtitle', 'caption', 'mp4', 'reel',
      // ⭐ media_chain's own vocabulary (2026-09-28).
      'dub', 'dubbing', 'dubbed', 'lipsync', 'media_chain'],
  },
  /**
   * ⚠️ `chart` IS ADDED TO THIS GROUP IN THE SAME COMMIT THAT DECLARES IT, and
   * that is not tidiness — it is the difference between costing nothing and
   * costing something on EVERY task. `shortlistTools` keeps any tool it cannot
   * classify (*"dropping what you do not understand is how capability
   * disappears quietly"*), so an unclassified verb rides along on "hi". Measured
   * on this package's own offer: `chart` + `syndicate` unclassified add 2,852
   * bytes to every single request; classified, they add 0 to an unsignalled one.
   */
  /**
   * ⭐ `profile_table` IS CLASSIFIED IN THE SAME COMMIT THAT DECLARES IT, for the
   * reason the note directly above states — an unclassified verb rides along on
   * "hi" forever. Its schema is 963 B; here it is 0 B on an unsignalled brief.
   *
   * ⚠️ AND `docs` IS THE RIGHT GROUP BECAUSE THE MEASURED BRIEFS SAY SO, not
   * because it is near `chart`. Both bench families that hit the read ceiling
   * name the file in the instruction — `bn-fit-modify` ("bn_sample_10k.csv") and
   * `large-scale-text-editing` ("/app/input.csv … to match /app/expected.csv") —
   * so the word `csv` already in this list is what offers it on exactly the runs
   * that were refused.
   *
   * ⚠️ IT SHARES A GROUP WITH `read_table` ON PURPOSE. That verb OCRs a PICTURE
   * of a table; this one streams a delimited file. They are the nearest miss in
   * the whole registry, and splitting them would let a model be offered the
   * wrong one alone — so `profile_table`'s description names the difference and
   * the shortlist always offers the pair together.
   */
  docs: {
    tools: ['make_document', 'read_document', 'read_table', 'chart', 'profile_table'],
    words: ['document', 'pdf', 'docx', 'spreadsheet', 'csv', 'excel', 'report', 'table', 'export',
      'chart', 'graph', 'plot', 'visuali', 'dashboard', 'data', 'tsv', 'column', 'histogram',
      // ⭐ The words a DATA brief uses that a chart brief does not.
      'rows', 'dataset', 'parquet', 'delimited',
      /**
       * ⭐ A DECK IS A DOCUMENT — found by using it (2026-09-27). "Make a 6-slide
       * deck … save it as deck.pptx" lit no group that holds `make_document`,
       * the verb that turns HTML into a real PPTX, so the run spent 17 rounds
       * hand-writing a ZIP writer and raw OOXML. Not bare `slide`: a UI
       * "slider" starts with it.
       */
      'pptx', 'powerpoint', 'slides', 'slide deck', 'deck', 'presentation'],
  },
  /**
   * ⭐ A NEW GROUP RATHER THAN A LINE IN `media`. The overlap is real — an
   * infographic is visual — but the WORDS are not: somebody asking for a blog
   * post and a thread is not asking for an image, and putting `syndicate` in
   * `media` would drag `generate_image`, `speak`, `transcribe` and four more
   * schemas along with it every time the word "post" appeared.
   */
  content: {
    tools: ['syndicate'],
    words: ['blog', 'post', 'thread', 'tweet', 'article', 'newsletter', 'social', 'infographic',
      'content', 'copy', 'announce', 'launch post', 'marketing', 'syndicate', 'publish', 'draft'],
  },
  repl: {
    tools: ['repl', 'repl_reset', 'run_program'],
    words: ['repl', 'interactive', 'experiment', 'try', 'explore', 'inspect', 'debug', 'session', 'python', 'node script'],
  },
  session: {
    tools: ['list_sessions'],
    words: ['session', 'resume', 'earlier', 'previous run', 'last time', 'history'],
  },
  /**
   * ⭐⭐ `inspect_binary` IS CLASSIFIED IN THE SAME COMMIT THAT DECLARES IT — the
   * rule this file states three times and has been burned by twice. Its schema is
   * 1,071 B; unclassified it would ride along on "hi" for ever, and here it is 0 B
   * on an unsignalled brief.
   *
   * ⚠️ A GROUP OF ONE, for `deploy`'s reason. The nearest existing homes are `db`
   * (a SQLite file IS a binary) and `docs`; joining either would drag that whole
   * group's schemas into every forensics brief and, worse, would offer
   * `inspect_binary` on the word "table", which is the commonest word in the
   * registry.
   *
   * ── ⚠️ THE WORDS ARE SUBSTRINGS, AND THE OBVIOUS ONE IS A TRAP ─────────────
   *
   * `'elf'` IS NOT ON THIS LIST AND MUST NOT BE. `text.includes('elf')` is true of
   * "yourself", "shelf", "self-contained" and "twelve" — it would fire on ordinary
   * English prose, which is the exact failure the `process` group's note records
   * for bare 'apt' (inside "adaptive") and bare 'pip' (inside "pipeline"). The
   * phrases below are what a brief about an ELF actually contains.
   *
   * ⭐ EVERY WORD CAME OUT OF A REAL BRIEF in `bench/terminal-bench/results`, not
   * out of a thesaurus: *"a compiled C binary"* (extract-elf), *"digital forensic
   * recovery … recover the PASSWORD from the deleted file"* (password-recovery),
   * *"the WAL file appears to be corrupted"* (db-wal-recovery), *"stored as a TF
   * .ckpt"* (gpt2-codegolf), *"an image at /app/image.ppm"* (path-tracing).
   *
   * ⚠️ `'binary'` IS KEPT DESPITE "binary search" AND "binary tree", and the
   * reason is that this verb carries TWO gates, not one. The offer gate
   * (`binaryEvidence`) already requires a binary file to be present in the
   * workspace, so a brief that says "write a binary search tree" in an
   * all-TypeScript repository never reaches this list at all. The false positive
   * costs 1,071 B and only in a repository that also ships a compiled artifact;
   * dropping the word costs the capability on the single brief that named it best.
   */
  binary: {
    tools: ['inspect_binary'],
    words: ['binary', 'executable', 'compiled', 'hexdump', 'hex dump', 'xxd', 'objdump', 'readelf',
      'elf binary', 'elf file', 'elf header', 'byte offset', 'magic number', 'file signature',
      'disassembl', 'decompil', 'reverse engineer', 'forensic', 'firmware', 'core dump',
      /**
       * ⚠️ 'shared object' AND '.so file', NEVER BARE '.so' — `text.includes('.so')`
       * is true of `array.sort`, `.source` and `.some(`, all of which appear in
       * ordinary coding briefs. Same trap as 'elf', one paragraph up.
       */
      'a.out', '.so file', 'shared object', '.dll', '.wasm', '.ckpt', '.ppm', '.bmp',
      'corrupted', 'deleted file'],
  },
});

const norm = (s) => String(s ?? '').toLowerCase();

/**
 * ── ⭐⭐ A GROUP WORD MUST START A WORD — ported from the builder, 2026-09-27 ──
 *
 * The matcher was `text.includes(w)`. The builder (`console/lib/
 * builder-tool-shortlist.ts` `wordStartRe`) fixed the identical defect on
 * 2026-09-02; this file, where the shortlist was born, never got the fix.
 *
 * ⚠️ FOUND BY USING IT, NOT BY A TEST: a real run on a cloned OSS repo was asked
 * to "install the dev dependencies". `ci` matched inside `dependen-ci-es`, lit
 * `vcs`, handed the model ten git/gh schemas — and it `git_commit`ed into the
 * user's repo, which nobody had asked for. Over 66 recorded briefs the
 * substring matcher lit 73 groups; 18 were mid-word hits, EVERY ONE a false
 * positive: `row` in `grows`/`arrow`, `voice` in `invoice`, `port` in
 * `report`/`exporting`, `try` in `retry`, `pr` in `price`, `ci` in `dependencies`.
 *
 * ⭐ ONLY THE START IS ANCHORED — suffixes still match (`commit`→`commits`,
 * `isolat`→`isolation`), so no plural is withdrawn. A word that itself starts
 * with punctuation (`.dll`, `.wasm`) keeps the substring test, because its own
 * dot is the boundary. Measured: 18 lost (all false), 0 gained.
 * Guard: `test/tool-shortlist-word-start.test.mjs`.
 */
const WORD_START = new Map();
export function wordStarts(text, word) {
  let re = WORD_START.get(word);
  if (!re) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    /**
     * ⚠️ A TWO-LETTER WORD MUST BE THE WHOLE WORD (a plural `s` allowed). Found
     * the same day: `pr` starts "Prove", "print", "product", "price"; `ci`
     * starts "city"; `db` starts "dbl". "Prove the .pptx has 6 slides" lit
     * `vcs` through `pr`. `PRs`, `DBs` still match.
     */
    const whole = word.length <= 2 && /^[a-z0-9]+$/.test(word) ? '(?:s)?(?![a-z0-9])' : '';
    re = new RegExp((/^[a-z0-9]/.test(word) ? '(?<![a-z0-9])' : '') + escaped + whole);
    WORD_START.set(word, re);
  }
  return re.test(text);
}

/** Which groups a task's own words point at. */
export function groupsForTask(task) {
  const text = norm(task);
  if (!text.trim()) return Object.keys(TOOL_GROUPS);
  const hit = [];
  for (const [name, g] of Object.entries(TOOL_GROUPS)) {
    if (g.words.some((w) => wordStarts(text, w))) hit.push(name);
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
   * ── ⚠️⚠️⭐ INVERTED 2026-08-25, AND THE OLD RULE IS KEPT HERE BECAUSE IT WAS
   *    REASONABLE AND STILL WRONG ────────────────────────────────────────────
   *
   * It read: `if (text.trim().length < 12) return [...allowed];` — *"an empty or
   * very short brief offers everything. 'fix it' carries no signal, and a
   * shortlist built from no evidence is a guess with consequences."*
   *
   * ⚠️ THE PREMISE IS SOUND AND THE CONCLUSION IS BACKWARDS. "No evidence" is
   * not a reason to send the LARGEST possible offer; it is a reason to send the
   * one that needs no evidence — the CORE, which is the spine of any coding task
   * and is offered under every signal anyway. The rule as written meant the
   * shortlist was structurally incapable of firing on the cheapest tasks, which
   * are precisely the ones where the head is the whole bill.
   *
   * ⚠️ AND THE COST OF BEING WRONG IS BOUNDED AT ONE ROUND, which is the fact
   * the old rule did not price in. Reaching for an unoffered tool widens the
   * offer to everything, permanently, for the session (`shouldWiden` below). A
   * wrong shortlist costs one wasted round; the old rule cost ~7,400 tokens on
   * EVERY round of every unsignalled task, for ever.
   *
   * MEASURED on this package's own offer (`toolNamesForRounds(5)`, 49 tools):
   *
   *     shortlistTools('hi')  before   49 tools   50,075 bytes
   *                           after    22 tools   19,275 bytes   −61.5%
   *
   * ⭐ AN EMPTY TASK IS STILL DIFFERENT, AND IT KEEPS THE FULL SURFACE. `''`
   * is not a short brief, it is the ABSENCE of one — a continuing interactive
   * turn whose real instruction is in the message history this function never
   * sees. Narrowing there would be guessing from evidence that exists and was
   * not shown to us, which is a different and worse mistake than guessing from
   * evidence that does not exist. `groupsForTask('')` returns every group for
   * exactly this reason, and that behaviour is unchanged.
   */
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
 * ⚠️⚠️ A NAMESPACED MCP TOOL IS OFFERED, AND IT IS NEVER IN `offered`.
 *
 * This shortlist governs the **registry** only. MCP schemas are appended to the
 * tool block separately and IN FULL (`turn.mjs`: `[...toolSchemasFor(offered),
 * ...mcpSchemas]`) — they are never narrowed, so they can never be the thing a
 * model was "not given". `offered` therefore does not and must not contain them.
 *
 * ⭐ MEASURED 2026-08-29, a real run against `mcp.deepwiki.com`: the model called
 * `mcp__deepwiki__ask_question` — a tool it HAD — and `shouldWiden` read that as
 * a wrong shortlist, so the offer widened permanently for the session:
 *
 *     round 1   35 tools   33,384 bytes
 *     round 2   62 tools   63,577 bytes   +30,193 B (+90.4%) EVERY REMAINING ROUND
 *
 * Two real CLI runs, two spurious widens (33→53 and 39→53). So attaching ANY MCP
 * server made the shortlist — the thing that buys the byte ceiling back — cost
 * more than it saved the first time the model used the server it was given. The
 * widen is also permanent, so the price is paid on every round to the cap.
 *
 * ⚠️ SKIPPING IS RIGHT EVEN WHEN THE NAME IS A HALLUCINATION. Widening adds
 * REGISTRY schemas; it can never conjure an MCP server that is not connected, so
 * `mcp__nope__x` would buy nothing and still cost 30KB a round.
 *
 * ⚠️ THE PREFIX IS `mcp.mjs`'s (`namespacedName`), not this file's invention.
 * `test/mcp-widen-namespace.test.mjs` pins the two together by CONSTRUCTING a
 * name with `namespacedName()` rather than by writing `mcp__` a second time, so
 * a change to the separator over there turns this red instead of silently
 * restoring the 30KB.
 */
const MCP_NAMESPACED = /^mcp__[a-z0-9_-]+__.+$/i;

/**
 * Did the model just reach for a tool it was not given? That is the signal to
 * widen — and it is a FACT, not a heuristic.
 */
export function shouldWiden(calledNames, offered) {
  const have = new Set(offered ?? []);
  return (calledNames ?? []).some(
    (n) => typeof n === 'string' && n && !MCP_NAMESPACED.test(n) && !have.has(n),
  );
}
