/**
 * ── ⭐⭐ POLICY — WHAT AN ORGANISATION IS ALLOWED TO SAY "NO" TO ──────────────
 *
 * Everything in this package so far is a limit *we* chose: `command.mjs` picks
 * the allowlisted binaries, `tools.mjs` picks which verbs a round may offer,
 * `cli-args.mjs` picks the round ceiling. All of them are excellent and none of
 * them are an admin's. A security reviewer's first question about a coding agent
 * is not "is it safe?", it is "**can I make it safe on my terms, and can I read
 * the rule I set?**" — and `ENTERPRISE.md:179` records the honest answer today:
 * no org policy at all.
 *
 * This file is that rule. Six things an org can say:
 *
 *   forbidTools     a named verb never runs        (`run_command`, `delete_file`, …)
 *   maxRounds       a ceiling on paid completions
 *   maxCostUsd      a ceiling on dollars per run
 *   requireDryRun   nothing may ever touch disk
 *   allowModels     only these model ids may be called
 *   allowMcp:false  no MCP server is spawned, ever
 *
 * ── ⚠️⚠️ THE PROBLEM THAT DEFINES THE DESIGN ────────────────────────────────
 *
 * **The policy file lives in the workspace, and the agent can write to the
 * workspace.** That is not a hypothetical: `WRITE_FORBIDDEN_ROOTS`
 * (`workspace.mjs:69`) is `.git`, `node_modules`, `.next`, `.vercel` — `.acuvo/`
 * is not in it, so `write_file(".acuvo/policy.json", "{}")` succeeds today. A
 * control the controlled party can edit is not a control.
 *
 * The obvious answers are all bad:
 *
 *   · *Detect tampering* — a hash check is a race. The agent edits the file, the
 *     next process reads the edited file and hashes the edited file.
 *   · *Make the file read-only* — a chmod the agent's own `npm run` script can
 *     undo, and on Windows barely a speed bump.
 *   · *Sign it* — a real answer, but it needs a key, and a key on the same
 *     machine as the agent is a key the agent can read.
 *
 * ⭐⭐ **SO WE DO NOT TRY TO STOP THE EDIT. WE MAKE THE EDIT USELESS.**
 *
 * Every field in a policy is merged by taking the STRICTER of the two values —
 * forbid-lists union, allow-lists intersect, numbers take the minimum, booleans
 * take the safer side. A layer can therefore only ever REMOVE permission. There
 * is no value the agent can write into `.acuvo/policy.json` that grants it
 * anything it did not already have. The worst it can do by writing that file is
 * restrict itself further, which is a denial of service against itself and not a
 * security event.
 *
 * That turns an unsolvable authenticity problem into a solved algebraic one:
 * `merge` is a meet on a lattice — commutative, idempotent, monotone downward —
 * so **"which file wins?" is not a question this system can be asked.** The
 * strictest statement anywhere wins, whoever wrote it.
 *
 * ── ⚠️ WHAT THAT STILL DOES NOT BUY, STATED PLAINLY ─────────────────────────
 *
 * Monotonicity protects the *contents*. It does not protect the file's
 * *existence*: an agent that deletes `.acuvo/policy.json` faces no workspace
 * restrictions on the NEXT run, because there is nothing left to read. Nothing
 * inside the workspace can fix that — the workspace is the thing under the
 * agent's hands.
 *
 * So the two layers mean genuinely different things, and the documentation must
 * not blur them:
 *
 *   **The workspace policy is a project CONVENTION.** Committable, reviewable in
 *   a PR, shared by the team, and adequate against mistakes.
 *
 *   **The admin policy is a CONTROL.** It lives at `$ACUVO_POLICY_FILE` or
 *   `~/.acuvo/policy.json` — outside the workspace, where the agent has no verb
 *   that reaches it: every path is refused before it leaves the root
 *   (`workspace.mjs:114`) and there is no shell to escape through
 *   (`command.mjs`). An org that needs enforcement rather than agreement puts
 *   the file there and owns the file permissions. Anyone who ships only the
 *   workspace half and calls it enterprise policy is lying.
 *
 * ⭐ And the mitigation for the deletion hole is one line in someone else's file,
 * which is why it is a reported recommendation and not code here: adding
 * `.acuvo` to `WRITE_FORBIDDEN_ROOTS` makes the whole directory read-but-never-
 * write. That also closes the strictly worse hole next door — `.acuvo/mcp.json`
 * is writable today, and MCP config names a **binary we spawn**
 * (`mcp.mjs:256`), so the agent can currently choose a program for the next run.
 *
 * ── ⚠️ FAIL CLOSED MEANS THE RUN DOES NOT START ─────────────────────────────
 *
 * A malformed policy returns `{ ok: false }` and the caller must refuse to run.
 * It must never fall back to "no policy". The failure mode being designed
 * against is a trailing comma in a JSON file quietly restoring an unrestricted
 * agent — the one bug where the symptom is *everything works fine*.
 *
 * ⭐ Unknown keys are an error for the same reason, and it is the subtle one:
 * `{"maxRoundz": 2}` is valid JSON, sets nothing, and reads to a human as a cap.
 * A typo that silently means "unlimited" is the exact shape of the accident this
 * file exists to prevent, so every key is checked against the known set and a
 * stranger stops the run.
 *
 * Pure throughout. The filesystem lives in exactly one function at the bottom,
 * and it takes its reader as an argument.
 */

import { TOOL_NAMES } from './tools.mjs';

/** Where a team commits its convention. Same `.acuvo/` directory as `mcp.json`. */
export const WORKSPACE_POLICY_FILE = '.acuvo/policy.json';
/** Where an admin puts the real control, and the env var that relocates it. */
export const USER_POLICY_FILE = '.acuvo/policy.json';
export const USER_POLICY_ENV = 'ACUVO_POLICY_FILE';

/**
 * A round is a paid completion, so an unbounded `maxRounds` in a config file is
 * a blank cheque. This is not the default — it is the largest number the parser
 * will accept as a deliberate statement.
 */
export const MAX_ROUNDS_CEILING = 64;
/** Above this a "cap" is decoration. Refused so a fat finger cannot pass review. */
export const MAX_COST_CEILING_USD = 1000;

/**
 * The keys a policy document may contain. Anything else stops the run — see the
 * header on why a typo that means "unlimited" is the dangerous kind.
 */
const KNOWN_KEYS = new Set([
  'forbidTools', 'allowTools', 'maxRounds', 'maxCostUsd',
  'requireDryRun', 'allowModels', 'denyModels', 'allowMcp',
  'allowWorkspacePolicy',
]);

/**
 * ⚠️ ADMIN-ONLY KEYS. `allowWorkspacePolicy` selects which layers are read, so
 * it is the one field that is NOT a lattice value — a workspace file that could
 * set it would be reaching outside the "may only restrict" guarantee to change
 * the merge itself. A workspace file that names it is refused rather than
 * ignored, because silently dropping a key someone wrote is how a config file
 * starts lying to its author.
 */
const ADMIN_ONLY_KEYS = new Set(['allowWorkspacePolicy']);

/**
 * The identity of the lattice: the policy you have when nobody has said
 * anything. It is deliberately PERMISSIVE — adding this module to the CLI must
 * change zero behaviour for the ninety-nine users who never write the file.
 * Restriction is opt-in; the safety floor is still the allowlists in
 * `command.mjs` and `workspace.mjs`, which no policy can lower or raise.
 */
export const OPEN_POLICY = Object.freeze({
  forbidTools: Object.freeze([]),
  /** `null` means "no whitelist", which is different from an empty whitelist. */
  allowTools: null,
  maxRounds: null,
  maxCostUsd: null,
  requireDryRun: false,
  allowModels: null,
  denyModels: Object.freeze([]),
  allowMcp: true,
  allowWorkspacePolicy: true,
  sources: Object.freeze([]),
});

// ── parsing ────────────────────────────────────────────────────────────────

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * A string list, validated element by element.
 *
 * ⚠️ Refuses a bare string where a list belongs. `"forbidTools": "run_command"`
 * is what a human writes on the first attempt, and treating a string as an
 * iterable of characters would forbid the tools `r`, `u`, `n`… and nothing else.
 * That is a fail-open typo, so it stops the run.
 */
function readStringList(value, key, label) {
  if (!Array.isArray(value)) {
    return { ok: false, error: `${label}: "${key}" must be an array of strings${typeof value === 'string' ? ` (got the string ${JSON.stringify(value)} — wrap it: ["${value}"])` : ''}` };
  }
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) {
      return { ok: false, error: `${label}: "${key}" contains ${JSON.stringify(item)}, which is not a non-empty string` };
    }
    out.push(item.trim());
  }
  return { ok: true, value: out };
}

/**
 * ⭐ A TOOL NAME IS CHECKED AGAINST THE REGISTRY, and this is the second
 * fail-open typo. `"forbidTools": ["run_commands"]` forbids nothing at all and
 * looks, in a code review, exactly like a policy that forbids shelling out. The
 * registry is right here (`tools.mjs`), so a name that cannot possibly match is
 * an error naming the near miss.
 *
 * ⚠️ MCP tools are exempt from the registry check and cannot be otherwise: they
 * are namespaced `mcp__<server>__<tool>` (`mcp.mjs:316`) and are discovered at
 * runtime by handshaking with a server, so at parse time we genuinely do not
 * know them. They are validated by SHAPE instead, which still catches a typo in
 * the prefix.
 */
function checkToolNames(names, key, label, knownTools) {
  for (const name of names) {
    if (name === '*') continue;
    if (name.startsWith('mcp__')) {
      if (!/^mcp__[a-z0-9_-]+__[^\s]+$/i.test(name)) {
        return { ok: false, error: `${label}: "${key}" has "${name}", which looks like an MCP tool but is not shaped mcp__<server>__<tool>` };
      }
      continue;
    }
    if (!knownTools.includes(name)) {
      const near = knownTools.filter((k) => k.startsWith(name.slice(0, 4)));
      return {
        ok: false,
        error: `${label}: "${key}" names "${name}", which is not a tool this agent has${near.length ? `. Did you mean ${near.slice(0, 3).map((n) => `"${n}"`).join(' or ')}?` : `. Known: ${knownTools.join(', ')}`}`,
      };
    }
  }
  return { ok: true };
}

function readBounded(value, key, label, { max, integer }) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { ok: false, error: `${label}: "${key}" must be a number (got ${JSON.stringify(value)})` };
  }
  if (integer && !Number.isInteger(value)) {
    return { ok: false, error: `${label}: "${key}" must be a whole number (got ${value})` };
  }
  // ⚠️ Zero is a legal, meaningful cap ("spend nothing", "run no rounds") and is
  // NOT the same as absent. Negative is a typo that would compare as "always
  // exceeded" or "never reached" depending on which way the check is written,
  // so it never reaches a comparison.
  if (value < 0) return { ok: false, error: `${label}: "${key}" cannot be negative (got ${value})` };
  if (value > max) return { ok: false, error: `${label}: "${key}" of ${value} exceeds the maximum ${max} this parser will accept as deliberate` };
  return { ok: true, value };
}

function readBoolean(value, key, label) {
  // ⚠️ Not truthiness. `"requireDryRun": "false"` is a truthy string, and the
  // opposite reading is the dangerous one for every boolean here.
  if (typeof value !== 'boolean') {
    return { ok: false, error: `${label}: "${key}" must be true or false (got ${JSON.stringify(value)})` };
  }
  return { ok: true, value };
}

/**
 * Parse ONE layer of policy from its JSON text.
 *
 * Returns a PARTIAL policy — only the keys the document actually stated — so
 * that merging can tell "said nothing" apart from "said the permissive thing".
 *
 * @param {string} text
 * @param {{ label?: string, admin?: boolean, knownTools?: readonly string[] }} [opts]
 */
export function parsePolicyDocument(text, { label = 'policy', admin = false, knownTools = TOOL_NAMES } = {}) {
  if (typeof text !== 'string') return { ok: false, error: `${label}: expected the file's text` };
  const trimmed = text.trim();
  // An empty file is a mistake with two readings ("I meant to write a policy"
  // and "I meant no policy") and only one of them is safe to guess, so neither
  // is guessed.
  if (!trimmed) return { ok: false, error: `${label}: the file is empty. Write {} for a policy that restricts nothing.` };

  let doc;
  try {
    doc = JSON.parse(trimmed);
  } catch (err) {
    return { ok: false, error: `${label}: not valid JSON — ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!isPlainObject(doc)) {
    return { ok: false, error: `${label}: the top level must be a JSON object` };
  }

  for (const key of Object.keys(doc)) {
    if (!KNOWN_KEYS.has(key)) {
      return { ok: false, error: `${label}: unknown setting "${key}". A misspelled cap sets nothing and reads like a cap. Known: ${[...KNOWN_KEYS].join(', ')}` };
    }
    if (!admin && ADMIN_ONLY_KEYS.has(key)) {
      return { ok: false, error: `${label}: "${key}" may only be set in the admin policy (${USER_POLICY_ENV} or ~/${USER_POLICY_FILE}), not in the workspace` };
    }
  }

  const out = {};

  for (const key of ['forbidTools', 'allowTools', 'denyModels', 'allowModels']) {
    if (!(key in doc)) continue;
    const list = readStringList(doc[key], key, label);
    if (!list.ok) return list;
    if (key === 'forbidTools' || key === 'allowTools') {
      const named = checkToolNames(list.value, key, label, knownTools);
      if (!named.ok) return named;
    }
    out[key] = list.value;
  }

  if ('maxRounds' in doc) {
    const r = readBounded(doc.maxRounds, 'maxRounds', label, { max: MAX_ROUNDS_CEILING, integer: true });
    if (!r.ok) return r;
    out.maxRounds = r.value;
  }
  if ('maxCostUsd' in doc) {
    const r = readBounded(doc.maxCostUsd, 'maxCostUsd', label, { max: MAX_COST_CEILING_USD, integer: false });
    if (!r.ok) return r;
    out.maxCostUsd = r.value;
  }
  for (const key of ['requireDryRun', 'allowMcp', 'allowWorkspacePolicy']) {
    if (!(key in doc)) continue;
    const r = readBoolean(doc[key], key, label);
    if (!r.ok) return r;
    out[key] = r.value;
  }

  return { ok: true, policy: out };
}

// ── the lattice ────────────────────────────────────────────────────────────

const union = (a, b) => [...new Set([...a, ...b])].sort();

/**
 * Does `broad` permit everything `narrow` permits?
 *
 * ⚠️ THIS IS WHY INTERSECTING WHITELISTS IS NOT `Set.has`, and the naive version
 * was written here first and caught by a test. Literal membership makes
 * `["deepseek/*"] ∩ ["*"]` **empty** — nothing allowed — because the string `*`
 * is not the string `deepseek/*`. It fails in the safe direction, so it is not a
 * hole, but it is still wrong twice over: a workspace file saying the permissive
 * thing would brick every run, and `["deepseek/*"] ∩ ["deepseek/deepseek-chat"]`
 * would refuse a model both layers plainly allow.
 *
 * A whitelist is a set of PATTERNS, so the intersection has to be taken over
 * what they MATCH, not over how they are spelled.
 */
function patternSubsumes(broad, narrow) {
  if (broad === '*') return true;
  if (broad.endsWith('/*')) return narrow === broad || narrow.startsWith(broad.slice(0, -1));
  return broad === narrow;
}

/**
 * Intersect two whitelists, where `null` means "did not restrict".
 *
 * Keeps every pattern from either side that the other side already permits —
 * which for the three shapes we support (`*`, `vendor/*`, an exact id) is
 * exactly their intersection, expressed in the same three shapes.
 *
 * ⭐ Still monotone: the result can never match something neither input matched,
 * which is the property the whole file rests on.
 */
function intersect(a, b) {
  if (a === null) return b === null ? null : [...b].sort();
  if (b === null) return [...a].sort();
  const kept = [
    ...a.filter((x) => b.some((y) => patternSubsumes(y, x))),
    ...b.filter((y) => a.some((x) => patternSubsumes(x, y))),
  ];
  return [...new Set(kept)].sort();
}

/** Take the smaller cap, where `null` means "did not cap". */
function minCap(a, b) {
  if (a === null || a === undefined) return b ?? null;
  if (b === null || b === undefined) return a;
  return Math.min(a, b);
}

/**
 * ⭐⭐ THE MEET. Every field moves one way only: toward less permission.
 *
 * This is the function the header is about. Because it is commutative,
 * idempotent and monotone downward, a layer written by the agent itself cannot
 * grant the agent anything — the worst a hostile `.acuvo/policy.json` achieves
 * is a stricter run. It also means the merge order is not load-bearing, so
 * nobody has to reason about precedence to audit what is in force.
 *
 * ⚠️ The one field it does NOT merge is `allowWorkspacePolicy`, which decides
 * whether a layer is read at all and is settled before we get here.
 */
export function mergePolicies(base, layer) {
  return {
    forbidTools: union(base.forbidTools ?? [], layer.forbidTools ?? []),
    allowTools: intersect(base.allowTools ?? null, layer.allowTools ?? null),
    maxRounds: minCap(base.maxRounds, layer.maxRounds),
    maxCostUsd: minCap(base.maxCostUsd, layer.maxCostUsd),
    // OR: once anyone has said "nothing may touch disk", nobody can unsay it.
    requireDryRun: Boolean(base.requireDryRun) || Boolean(layer.requireDryRun),
    allowModels: intersect(base.allowModels ?? null, layer.allowModels ?? null),
    denyModels: union(base.denyModels ?? [], layer.denyModels ?? []),
    // AND: one `false` anywhere means no server is spawned.
    allowMcp: base.allowMcp !== false && layer.allowMcp !== false,
    allowWorkspacePolicy: base.allowWorkspacePolicy !== false,
    sources: base.sources ?? [],
  };
}

/**
 * Build the effective policy from the layer texts.
 *
 * PURE — it takes text, not paths, which is why the whole suite tests the real
 * decision logic without touching a disk.
 *
 * @param {{ adminText?: string|null, adminLabel?: string, workspaceText?: string|null, workspaceLabel?: string, knownTools?: readonly string[] }} input
 */
export function loadPolicy({
  adminText = null, adminLabel = `~/${USER_POLICY_FILE}`,
  workspaceText = null, workspaceLabel = WORKSPACE_POLICY_FILE,
  knownTools = TOOL_NAMES,
} = {}) {
  let effective = { ...OPEN_POLICY, forbidTools: [], denyModels: [], sources: [] };
  const sources = [];

  if (adminText !== null && adminText !== undefined) {
    const parsed = parsePolicyDocument(adminText, { label: adminLabel, admin: true, knownTools });
    if (!parsed.ok) return parsed;
    effective = mergePolicies(effective, parsed.policy);
    if (parsed.policy.allowWorkspacePolicy === false) effective.allowWorkspacePolicy = false;
    sources.push({ label: adminLabel, trusted: true });
  }

  if (workspaceText !== null && workspaceText !== undefined) {
    /**
     * ⚠️ An admin can switch the workspace layer off entirely. Redundant against
     * a hostile agent (it could not widen anything anyway) but not against a
     * hostile HUMAN: a contractor committing `{"maxRounds": 0}` would otherwise
     * be able to brick every run on the machine, and "the agent refuses to do
     * anything and nobody knows why" is a support ticket, not a security win.
     */
    if (effective.allowWorkspacePolicy === false) {
      sources.push({ label: workspaceLabel, trusted: false, ignored: true });
    } else {
      const parsed = parsePolicyDocument(workspaceText, { label: workspaceLabel, admin: false, knownTools });
      if (!parsed.ok) return parsed;
      effective = mergePolicies(effective, parsed.policy);
      sources.push({ label: workspaceLabel, trusted: false });
    }
  }

  effective.sources = sources;
  return { ok: true, policy: effective };
}

// ── decisions ──────────────────────────────────────────────────────────────

/**
 * May this tool be offered and dispatched?
 *
 * ⚠️ THE ANSWER MUST BE USED IN BOTH PLACES. Filtering the OFFER stops the model
 * wasting a round on a dead button; checking at DISPATCH is what makes it a
 * control, because a model can emit a call for a tool it was never shown (and
 * MCP tools arrive after the offer is built). Doing only the first is a UI, not
 * a policy.
 */
export function toolDecision(policy, name) {
  if (typeof name !== 'string' || !name) {
    return { allowed: false, reason: 'a tool call with no name is refused' };
  }
  if (policy.forbidTools?.includes('*')) {
    return { allowed: false, reason: 'policy forbids every tool' };
  }
  if (policy.forbidTools?.includes(name)) {
    return { allowed: false, reason: `policy forbids ${name}` };
  }
  if (policy.allowTools) {
    if (policy.allowTools.includes('*')) return { allowed: true, reason: null };
    if (!policy.allowTools.includes(name)) {
      return { allowed: false, reason: `policy allows only ${policy.allowTools.join(', ')} — ${name} is not on the list` };
    }
  }
  return { allowed: true, reason: null };
}

/** The offer side of the same decision, order preserved (the order is a hint —
 *  see `tools.mjs` on edit-before-write). */
export function filterToolNames(policy, names) {
  return names.filter((n) => toolDecision(policy, n).allowed);
}

/**
 * Model patterns: an exact id, `vendor/*`, or `*`.
 *
 * ⚠️ DELIBERATELY NOT A REGEX AND NOT A GENERAL GLOB. `search.mjs:83` already
 * carries the note that compiling a foreign string with `new RegExp` is a
 * catastrophic-backtracking DoS in one call, and a policy file is exactly the
 * kind of foreign string. Two shapes cover every real rule ("only DeepSeek",
 * "only this pinned id") and neither can be made to hang.
 */
export function matchesModelPattern(pattern, id) {
  if (pattern === '*') return true;
  if (pattern.endsWith('/*')) return id.startsWith(pattern.slice(0, -1));
  return pattern === id;
}

/**
 * May this model id be called?
 *
 * ⚠️ THIS IS THE FIELD MOST LIKELY TO BE ENFORCED IN THE WRONG PLACE. The chain
 * (`chain.mjs:56`) substitutes a DIFFERENT model on a retry, and `buildChain`
 * appends three defaults nobody asked for — so a check at the top of the run
 * proves nothing about the model that actually answered. The call site has to be
 * inside the chain loop, per candidate. A jurisdiction rule ("nothing routed via
 * a Chinese provider") is worthless if the fallback quietly ignores it.
 */
export function modelDecision(policy, id) {
  if (typeof id !== 'string' || !id) return { allowed: false, reason: 'an empty model id is refused' };
  for (const p of policy.denyModels ?? []) {
    if (matchesModelPattern(p, id)) return { allowed: false, reason: `policy denies model ${id} (matched "${p}")` };
  }
  if (policy.allowModels) {
    const hit = policy.allowModels.some((p) => matchesModelPattern(p, id));
    if (!hit) return { allowed: false, reason: `policy allows only ${policy.allowModels.join(', ')} — ${id} is not among them` };
  }
  return { allowed: true, reason: null };
}

/** Lower a requested round budget to the policy ceiling. Never raises it — a
 *  policy is a limit, not a default. */
export function roundBudget(policy, requested) {
  const cap = policy.maxRounds;
  if (cap === null || cap === undefined) return { rounds: requested, capped: false, reason: null };
  if (requested <= cap) return { rounds: requested, capped: false, reason: null };
  return { rounds: cap, capped: true, reason: `policy caps rounds at ${cap} (you asked for ${requested})` };
}

/**
 * ── ⭐ THE COST CAP, AND THE TWO WAYS IT IS USUALLY BUILT WRONG ─────────────
 *
 * (1) **A cap checked after the fact is a cap that is always breached once.**
 * `spent >= cap → stop` lets the round that crosses the line complete and bill.
 * So the next round's likely cost is PROJECTED from the last one and the stop
 * happens before the spend, not after it. `lastRoundUsd` is the estimator we
 * have; it is not a promise, and the reason string says "would".
 *
 * (2) ⚠️⚠️ **A provider that reports no cost must not read as free.**
 * `aggregateUsage` (`turn.mjs:1136`) returns `null` when nothing reported usage,
 * and `null` coerced through arithmetic becomes 0 — a $0.00 running total under
 * a $5 cap, forever. Fail closed: an unenforceable cap stops the run and says
 * why. One round is allowed first, because you cannot learn whether a provider
 * reports cost without spending one.
 */
export function costDecision(policy, { spentUsd = null, roundsUsed = 0, lastRoundUsd = null } = {}) {
  const cap = policy.maxCostUsd;
  if (cap === null || cap === undefined) return { ok: true, stop: false, reason: null };

  if (typeof spentUsd !== 'number' || !Number.isFinite(spentUsd)) {
    if (roundsUsed < 1) return { ok: true, stop: false, reason: null };
    return {
      ok: false,
      stop: true,
      reason: `policy caps spend at $${cap.toFixed(4)} but the provider reported no cost, so the cap cannot be enforced — stopping rather than spending blind`,
    };
  }

  if (spentUsd >= cap) {
    return { ok: false, stop: true, reason: `policy cost cap reached: $${spentUsd.toFixed(6)} of $${cap.toFixed(4)}` };
  }
  const projected = spentUsd + (typeof lastRoundUsd === 'number' && Number.isFinite(lastRoundUsd) ? lastRoundUsd : 0);
  if (projected > cap) {
    return {
      ok: false,
      stop: true,
      reason: `stopping at $${spentUsd.toFixed(6)}: another round would cost about $${Number(lastRoundUsd).toFixed(6)} and exceed the $${cap.toFixed(4)} cap`,
    };
  }
  return { ok: true, stop: false, reason: null };
}

/** MCP is one boolean, but it is the one that decides whether a foreign binary
 *  is spawned, so it gets a named decision rather than an inline `if`. */
export function mcpDecision(policy) {
  return policy.allowMcp === false
    ? { allowed: false, reason: 'policy disables MCP — no server is spawned and no remote tool is offered' }
    : { allowed: true, reason: null };
}

/**
 * Check the whole invocation before a single completion is bought.
 *
 * ⭐ REFUSE UP FRONT RATHER THAN CLAMP SILENTLY. `--max-rounds` over the cap is
 * lowered (a ceiling is a ceiling, and the run is still what was asked for), but
 * `requireDryRun` without `--dry-run` is a different intent entirely — running
 * it "safely" would mean doing a job the user did not ask for and reporting
 * success. That one stops with a sentence naming the flag to add.
 *
 * @param {object} policy
 * @param {{ dryRun?: boolean, allowRun?: boolean, maxRounds?: number, model?: string|null }} options
 */
export function invocationDecision(policy, options = {}) {
  const violations = [];
  const notes = [];

  if (policy.requireDryRun && !options.dryRun) {
    violations.push('policy requires --dry-run: this agent may plan and print, but may not write to disk here');
  }
  if (options.model) {
    const m = modelDecision(policy, options.model);
    if (!m.allowed) violations.push(m.reason);
  }
  if (typeof options.maxRounds === 'number') {
    const r = roundBudget(policy, options.maxRounds);
    if (r.capped) notes.push(r.reason);
  }
  /**
   * ⚠️ `forbidTools: ["run_command"]` and `--no-run` are the same intent
   * expressed twice, and only one of them currently reaches `evaluate` and
   * `git_commit` (`tools.mjs:toolNamesForRounds`). Surfacing it as a note keeps
   * the two from drifting into "the policy said no and the flag said yes".
   */
  if (options.allowRun === true && (policy.forbidTools ?? []).includes('run_command')) {
    notes.push('policy forbids run_command, so nothing will be executed even though --no-run was not passed');
  }

  return { ok: violations.length === 0, violations, notes };
}

// ── the file itself ────────────────────────────────────────────────────────

/**
 * ⭐ THE POLICY DIRECTORY IS NOT THE AGENT'S TO EDIT, and this is the check that
 * says so at the point of a write.
 *
 * It is defence in depth, NOT the security boundary — the boundary is the
 * monotone merge above, because this check lives in the same process as the
 * agent and only covers the verbs that consult it. It is here because an agent
 * that "helpfully" rewrites the config governing it is a confusing failure even
 * when it is a harmless one, and because the same directory holds `mcp.json`,
 * where a write genuinely is remote code execution on the next run.
 *
 * ⚠️ Takes an ALREADY-NORMALISED workspace-relative path (see
 * `normalizeRelativePath`, `workspace.mjs:114`). Given a raw model string it
 * would be comparing against `.\.acuvo\policy.json` and every other spelling.
 */
export function isPolicyProtectedPath(relPath) {
  if (typeof relPath !== 'string') return false;
  return relPath === '.acuvo' || relPath.startsWith('.acuvo/');
}

/**
 * A short stable id for the effective policy, for the audit line and for
 * comparing two machines' configuration in a bug report.
 *
 * ⚠️ NOT A SECURITY MECHANISM AND MUST NEVER BE DESCRIBED AS ONE. FNV-1a, chosen
 * because this package has zero dependencies and no reason to acquire a crypto
 * import for a label. It answers "are these two runs governed by the same
 * rules?", never "did someone tamper with this?" — the header explains why the
 * tamper question is not answerable from inside the workspace anyway.
 */
export function policyFingerprint(policy) {
  const canonical = JSON.stringify([
    policy.forbidTools ?? [], policy.allowTools ?? null,
    policy.maxRounds ?? null, policy.maxCostUsd ?? null,
    Boolean(policy.requireDryRun), policy.allowModels ?? null,
    policy.denyModels ?? [], policy.allowMcp !== false,
  ]);
  let h = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i += 1) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * The lines to print when a policy is in force.
 *
 * ⭐ A POLICY NOBODY CAN SEE IS A POLICY NOBODY TRUSTS — and worse, it is
 * indistinguishable from a broken agent. "It refused to run the tests" needs to
 * read as "your policy forbids run_command", or the next hour is spent debugging
 * the CLI. Returns `[]` when nothing is restricted, so an unconfigured user
 * never sees a line about a feature they are not using.
 */
export function describePolicy(policy) {
  const lines = [];
  if (policy.requireDryRun) lines.push('dry-run only — nothing will be written');
  if (policy.allowTools) lines.push(`tools limited to: ${policy.allowTools.join(', ')}`);
  if (policy.forbidTools?.length) lines.push(`tools forbidden: ${policy.forbidTools.join(', ')}`);
  if (policy.maxRounds !== null && policy.maxRounds !== undefined) lines.push(`at most ${policy.maxRounds} round${policy.maxRounds === 1 ? '' : 's'}`);
  if (policy.maxCostUsd !== null && policy.maxCostUsd !== undefined) lines.push(`at most $${policy.maxCostUsd} per run`);
  if (policy.allowModels) lines.push(`models limited to: ${policy.allowModels.join(', ')}`);
  if (policy.denyModels?.length) lines.push(`models denied: ${policy.denyModels.join(', ')}`);
  if (policy.allowMcp === false) lines.push('MCP disabled — no external server will be spawned');
  if (!lines.length) return [];
  const where = (policy.sources ?? []).map((s) => `${s.label}${s.ignored ? ' (ignored)' : ''}`).join(' + ') || 'defaults';
  return [`policy [${policyFingerprint(policy)}] from ${where}:`, ...lines.map((l) => `  · ${l}`)];
}

/**
 * The ONLY function here that touches a disk, and it takes its reader as an
 * argument so nothing above it needs one.
 *
 * ⚠️ ABSENT IS NOT MALFORMED. A missing file is the overwhelmingly common case
 * and means "no policy at this layer"; an unreadable-but-present file is a
 * broken control and stops the run. Conflating them is how fail-closed quietly
 * becomes fail-open on a permissions error.
 *
 * @param {string} root workspace root
 * @param {{ env?: object, home?: string|null, readFileImpl?: (p: string) => string, joinImpl?: (...p: string[]) => string }} [deps]
 */
export function readPolicySources(root, { env = process.env, home = null, readFileImpl, joinImpl } = {}) {
  const join = joinImpl ?? ((...p) => p.join('/').replace(/\/+/g, '/'));
  const read = readFileImpl;
  if (typeof read !== 'function') return { ok: false, error: 'readPolicySources needs a reader' };

  const slurp = (abs) => {
    try {
      return { found: true, text: read(abs) };
    } catch (err) {
      const code = err && typeof err === 'object' ? err.code : null;
      if (code === 'ENOENT' || code === 'ENOTDIR') return { found: false, text: null };
      return { found: true, text: null, error: `${abs}: ${err instanceof Error ? err.message : String(err)}` };
    }
  };

  const override = String(env[USER_POLICY_ENV] ?? '').trim();
  const adminPath = override || (home ? join(home, USER_POLICY_FILE) : null);
  let adminText = null;
  if (adminPath) {
    const r = slurp(adminPath);
    if (r.error) return { ok: false, error: `admin policy could not be read — ${r.error}` };
    /**
     * ⚠️ AN EXPLICIT `ACUVO_POLICY_FILE` POINTING AT NOTHING IS AN ERROR, while
     * an absent `~/.acuvo/policy.json` is not. Somebody set that variable on
     * purpose; a typo in it silently meaning "unrestricted" is the deployment
     * accident this whole file is built to refuse.
     */
    if (!r.found && override) return { ok: false, error: `${USER_POLICY_ENV} points at ${override}, which does not exist` };
    adminText = r.found ? r.text : null;
  }

  const wsPath = join(root, WORKSPACE_POLICY_FILE);
  const w = slurp(wsPath);
  if (w.error) return { ok: false, error: `workspace policy could not be read — ${w.error}` };

  return {
    ok: true,
    adminText,
    adminLabel: adminPath ?? `~/${USER_POLICY_FILE}`,
    workspaceText: w.found ? w.text : null,
    workspaceLabel: WORKSPACE_POLICY_FILE,
  };
}
