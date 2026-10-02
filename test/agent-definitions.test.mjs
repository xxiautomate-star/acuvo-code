/**
 * ── NAMED SPECIALISTS: `.acuvo/agents/*.md` AND CLAUDE CODE'S `.claude/agents` ─
 *
 * The security half is proven directly (a file can NARROW a helper, never
 * widen it), and the reach half is proven through the real dispatcher
 * (`executeToolCall` → `delegate` → `runSubagent` → the session it starts),
 * because a resolver that nothing calls is the defect this package keeps
 * shipping.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseAgentFile, resolveAgentTools, loadAgentDefinitions, findAgent, agentsPromptBlock, describeAgents, taskForAgent,
} from '../lib/agent-definitions.mjs';
import { runSubagent, SUBAGENT_VERIFY_TOOL_NAMES, SUBAGENT_TOOL_NAMES } from '../lib/subagent.mjs';
import { executeToolCall } from '../lib/tools.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-agents-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const put = (dir, rel, text) => {
  mkdirSync(join(dir, rel, '..'), { recursive: true });
  writeFileSync(join(dir, rel), text, 'utf8');
};

test('parses Claude Code\'s frontmatter, comma and YAML-list tool forms', () => {
  const a = parseAgentFile('---\nname: code-reviewer\ndescription: "Reviews diffs"\ntools: Read, Grep, Glob\nmodel: sonnet\n---\nYou review code.\n');
  assert.equal(a.ok, true);
  assert.equal(a.meta.name, 'code-reviewer');
  assert.equal(a.meta.description, 'Reviews diffs');
  assert.equal(a.meta.tools, 'Read, Grep, Glob');
  assert.equal(a.body, 'You review code.');
  const b = parseAgentFile('---\nname: x\ntools:\n  - Read\n  - Write\n---\nbody');
  assert.deepEqual(b.meta.tools, ['Read', 'Write']);
  assert.equal(parseAgentFile('---\nname: x\nno close').ok, false, 'an unterminated block is refused, not half-read');
});

test('⭐⭐⭐ a definition can NARROW a helper, never WIDEN it', () => {
  const none = resolveAgentTools(undefined);
  assert.equal(none.mode, 'read', 'no tools: line = read-only researcher (Claude Code would inherit everything; we do not)');
  assert.deepEqual(none.toolNames, [...SUBAGENT_TOOL_NAMES]);

  const greedy = resolveAgentTools('Read, git_push, WebFetch, delegate, shell, Bash(rm -rf:*)');
  for (const t of greedy.toolNames) {
    assert.ok(SUBAGENT_VERIFY_TOOL_NAMES.includes(t), `"${t}" is outside every helper ceiling and reached the offer`);
  }
  assert.ok(!greedy.toolNames.includes('git_push'));
  assert.ok(!greedy.toolNames.includes('delegate'), 'a file must never hand a helper a second level of delegation');
  assert.deepEqual(greedy.ignoredTools.sort(), ['WebFetch', 'delegate', 'git_push', 'shell'].sort(), 'ignored names are REPORTED, not silently dropped');

  assert.equal(resolveAgentTools('Read, Grep').mode, 'read');
  assert.equal(resolveAgentTools('Read, Edit').mode, 'write');
  const runner = resolveAgentTools('Bash');
  assert.equal(runner.mode, 'verify', 'a run verb exists for a helper only inside an isolated copy');
  assert.ok(runner.toolNames.includes('read_file'), 'never an offer with nothing to read with');
});

test('.acuvo/agents wins a name clash; .claude/agents is read as-is; model aliases are refused', (t) => {
  const dir = workspace(t);
  put(dir, '.acuvo/agents/reviewer.md', '---\nname: reviewer\ndescription: ours\n---\nOURS');
  put(dir, '.claude/agents/reviewer.md', '---\nname: reviewer\ndescription: theirs\n---\nTHEIRS');
  put(dir, '.claude/agents/Test Writer.md', '---\ndescription: writes tests\ntools: Read, Write\nmodel: sonnet\n---\nWrite tests.');
  const defs = loadAgentDefinitions({ root: dir, home: null });
  assert.equal(defs.agents.length, 2);
  assert.equal(findAgent(defs, 'reviewer').description, 'ours');
  const tw = findAgent(defs, 'Test Writer');
  assert.ok(tw, 'a name taken from the filename is normalised the way a person would type it');
  assert.equal(tw.name, 'test-writer');
  assert.equal(tw.mode, 'write');
  assert.equal(tw.model, null, '"sonnet" means nothing to our router and must not move spend');
  assert.equal(tw.ignoredModel, 'sonnet');
  assert.match(describeAgents(defs), /model "sonnet" ignored/);
  assert.match(agentsPromptBlock(defs), /test-writer \(builds\) — writes tests/);
  assert.equal(agentsPromptBlock({ agents: [] }), '', 'a workspace with no agents pays zero bytes');
});

test('runSubagent re-checks a passed tool list against its own ceiling', async () => {
  const seen = [];
  const sessionImpl = async (o) => { seen.push(o); return { ok: true, note: 'x', executed: [], usage: null, roundsUsed: 1 }; };
  const exec = createLocalExecutor(tmpdir());
  await runSubagent({ task: 't', executor: exec, config: { apiKey: 'k', model: 'base/m' }, toolNames: ['read_file', 'write_file', 'git_push'], model: 'vendor/special' }, { sessionImpl });
  assert.deepEqual(seen[0].toolNames, ['read_file'], 'a READ helper held a write verb because a list said so');
  assert.equal(seen[0].config.model, 'vendor/special');
  assert.equal(seen[0].config.apiKey, 'k', 'only the model is swapped — key and chain stay the parent\'s');
});

test('⭐⭐⭐ the real dispatcher: `agent` resolves the file, prepends its instructions, and the FILE decides the mode', async (t) => {
  const dir = workspace(t);
  put(dir, '.acuvo/agents/auditor.md', '---\nname: auditor\ndescription: finds dead code\ntools: Read, Grep\n---\nOnly ever report; never edit.');
  let handed = null;
  const helper = async (a) => { handed = a; return { ok: true, summary: 'found 2', costUsd: 0, tokens: 0, roundsUsed: 1, files: [] }; };
  const call = { id: '1', function: { name: 'delegate', arguments: JSON.stringify({ task: 'find dead exports', agent: 'auditor', write: true }) } };
  const rec = await executeToolCall(call, createLocalExecutor(dir), { config: { apiKey: 'k' }, subagentImpl: helper });
  assert.equal(rec.result.ok, true, JSON.stringify(rec.result));
  assert.ok(handed.task.startsWith('--- YOU ARE THE "auditor" AGENT'), 'the definition\'s instructions lead the task');
  assert.match(handed.task, /Only ever report; never edit\.[\s\S]*find dead exports/);
  assert.equal(handed.write, false, 'the model asked for write:true, and a read-only FILE must win');
  assert.equal(handed.verify, false);
  assert.deepEqual(handed.toolNames, ['read_file', 'read_lines', 'read_around', 'search_text']);
});

test('an unknown agent is refused BEFORE any spend, naming the real ones', async (t) => {
  const dir = workspace(t);
  put(dir, '.acuvo/agents/auditor.md', '---\nname: auditor\n---\nx');
  let called = false;
  const helper = async () => { called = true; return { ok: true, summary: '' }; };
  const call = { id: '1', function: { name: 'delegate', arguments: JSON.stringify({ task: 'x', agent: 'audtor' }) } };
  const rec = await executeToolCall(call, createLocalExecutor(dir), { config: { apiKey: 'k' }, subagentImpl: helper });
  assert.equal(rec.result.ok, false);
  assert.match(rec.result.error, /no agent named "audtor".*auditor/);
  assert.equal(called, false, 'a helper silently falling back to a generic researcher does the wrong job at full price');
});

test('taskForAgent leaves a task untouched when there is no definition', () => {
  assert.equal(taskForAgent(null, 'x'), 'x');
});

test('/agents and /hooks are registered, reachable from /help, and render what the providers give', async () => {
  const { runSlashCommand, SLASH_COMMANDS } = await import('../lib/slash.mjs');
  const names = SLASH_COMMANDS.map((c) => c.name);
  assert.ok(names.includes('agents') && names.includes('hooks'));
  const out = runSlashCommand({ name: 'agents', args: '' }, { agents: () => 'reviewer  [read]\n    tools: read_file' }).output.join('\n');
  assert.match(out, /reviewer {2}\[read\]/);
  const bare = runSlashCommand({ name: 'hooks', args: '' }, {}).output.join('\n');
  assert.match(bare, /not available/);
  const { describeHooks } = await import('../lib/hooks.mjs');
  assert.match(describeHooks({ ok: false, error: 'bad json', path: '.acuvo/hooks.json' }).join('\n'), /NO HOOKS ARE RUNNING — bad json/);
});

test('GEMINI.md is read as project memory, after CLAUDE.md', async () => {
  const { MEMORY_FILES } = await import('../lib/project-memory.mjs');
  assert.ok(MEMORY_FILES.includes('GEMINI.md'));
  assert.ok(MEMORY_FILES.indexOf('GEMINI.md') > MEMORY_FILES.indexOf('CLAUDE.md'));
});
