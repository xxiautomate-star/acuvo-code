/**
 * The refuter's tool list — read and RUN, never write.
 *
 * ⚠️ ITS OWN MODULE, not a constant inside `refute.mjs`, because `tools.mjs`
 * needs it too and `refute.mjs` imports `turn.mjs` lazily. Putting the list
 * where both can reach it without a cycle is the whole reason this file exists.
 *
 * ⭐ RUNNING IS ESSENTIAL. The strongest refutation available is a command that
 * fails; a reviewer that can only read is reduced to opinion, which the
 * refuter's prompt explicitly refuses to accept as a refutation.
 *
 * ⚠️ AND WRITING IS ABSENT, not merely discouraged. A refuter that fixes what it
 * finds is no longer refuting, and its unreviewed "fix" would land on top of
 * work somebody was about to inspect. `write_file`, `write_files`, `edit_file`,
 * `delete_file`, `git_commit` and `evaluate` are all missing on purpose —
 * `evaluate` especially, because it starts a process that can write anything.
 */
export const REFUTER_TOOL_NAMES = Object.freeze([
  'read_file',
  'read_lines',
  'read_around',
  'list_dir',
  'find_files',
  'search_text',
  'find_definition',
  'find_references',
  'list_symbols',
  'check_types',
  'git_status',
  'git_diff',
  'git_log',
  'run_command',
  'run_program',
]);
