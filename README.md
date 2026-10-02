<div align="center">

# Acuvo Code

**An AI coding agent for your terminal. It writes the code, runs it, reads the failure, and fixes it.**

[![npm](https://img.shields.io/npm/v/acuvo-code?color=0b7285&label=npm)](https://www.npmjs.com/package/acuvo-code)
[![node](https://img.shields.io/badge/node-%E2%89%A520-0b7285)](https://nodejs.org)
[![dependencies](https://img.shields.io/badge/dependencies-0-0b7285)](package.json)
[![license](https://img.shields.io/badge/license-FSL--1.1--ALv2-0b7285)](#license)

[Website](https://acuvo.ai) · [npm](https://www.npmjs.com/package/acuvo-code) · [Changelog](CHANGELOG.md) · [Issues](https://github.com/xxiautomate-star/acuvo-code/issues)

</div>

## Install

```bash
npm i -g acuvo-code
```

Requires Node 20 or newer. The package has zero runtime dependencies.

## Quickstart

```bash
acuvo --login                          # sign in once, in your browser
acuvo "fix the failing test"           # give it a task
acuvo                                  # or start an interactive session
```

`acuvo --login` connects the CLI to your [Acuvo](https://acuvo.ai) account. Model calls are billed
to that account, so there are no provider API keys to manage. By default the CLI talks to the
Acuvo gateway at `https://acuvo.xxiautomate.com/api/cli/v1/chat/completions`; set
`ACUVO_GATEWAY_URL` to point it elsewhere. `acuvo --whoami` shows which account is in use.

## Features

- **Write, run, repair.** Runs the tests or program it just changed, feeds real exit codes and
  stack traces back into the next round, and only reports done when the check passes.
- **Safe by default.** Commands run through an allowlist (no shell unless you pass `--shell`),
  pushes, deploys, installs and GitHub writes are each off until you enable them, and every run
  is checkpointed so `acuvo rewind` can restore your files.
- **Spend limits.** A per-run budget is on by default; `--budget`, `--fleet-budget` and
  `acuvo spend` keep cost visible and bounded.
- **Interactive or scripted.** A full interactive prompt with slash commands, `@file` mentions
  and session resume, or one-shot runs with `--json` / `--output-format stream-json` for CI.
- **Plan, verify, review.** `--plan` to approve an approach first, `--refute` for an
  independent second opinion, `/review` for a code review of your diff.
- **GitHub workflow.** `acuvo --issue <n>` reads an issue, branches, fixes it and runs the tests.
- **Parallel work.** `--parallel` runs several tasks at once; `--best-of <n>` tries a task in
  isolated copies and keeps the one that verifies.
- **Extensible.** Project skills, custom `/commands`, hooks, sub-agents and plugins live in
  `.acuvo/`. Reads `CLAUDE.md`, `AGENTS.md` and `GEMINI.md` as project memory.
- **MCP, both directions.** Connects to any MCP server, and ships its own so Claude Code,
  Cursor, VS Code and Windsurf can use Acuvo.

## Usage

```bash
acuvo "add a --json flag to the export command"   # make a change and verify it
acuvo --plan "migrate the config loader to zod"    # review the plan before anything runs
acuvo --no-run "sketch a migration plan"           # read and write files, execute nothing
acuvo --resume <id> "now add tests"                # continue a saved session
acuvo rewind                                       # list checkpoints and undo a run
acuvo --doctor                                     # check what is configured on this machine
```

Run `acuvo --help` for every flag and command.

## Configuration

Settings resolve in this order: command-line flag, environment variable, `~/.acuvo/config.json`,
then `.acuvo/config.json` in the project. A `.env` file beside your project is also loaded.

| Setting | Flag | Environment |
|---|---|---|
| Model (`acuvo-flash` default, or `acuvo-pro`) | `--model` | `ACUVO_MODEL` |
| When a task counts as done | `--done` | `ACUVO_DONE` |
| When to ask before writing | `--approve` | `ACUVO_APPROVE` |
| Extra language toolchains (python, go, rust, ...) | | `ACUVO_ALLOW_COMMANDS` |
| Gateway endpoint | | `ACUVO_GATEWAY_URL` |

Per-project extensions:

| Path | Purpose |
|---|---|
| `.acuvo/skills/*.md` | Skills the agent loads on demand |
| `.acuvo/commands/*.md` | Your own `/commands` |
| `.acuvo/agents/*.md` | Named sub-agents |
| `.acuvo/hooks.json` | Shell hooks around tool calls; a failing `PreToolUse` hook blocks the call |
| `.acuvo/mcp.json` | MCP servers to connect |
| `.acuvo/commands.json` | Command presets, e.g. `{"presets":["python"]}` |

## Use Acuvo from your editor (MCP)

Acuvo ships two MCP servers. The hosted one reaches your Acuvo account; the local one works on
the files in a folder. Install both into whichever editors are present:

```bash
acuvo mcp install --hosted --yes
acuvo mcp install --yes
```

The command detects Claude Code, Cursor, VS Code and Windsurf, shows every change, and writes
nothing without `--yes`. Claude Desktop takes remote servers through **Settings → Connectors**
instead.

To add the hosted server (`acuvo-cloud`) by hand:

```bash
claude mcp add --transport http acuvo-cloud https://acuvo.xxiautomate.com/api/mcp/rpc \
  --header "Authorization: Bearer <your Acuvo API key>"
```

The local server is the `acuvo-mcp` binary over stdio. It serves no tools until you grant them:
`--root <dir>` for read access, `--allow-write` for edits, `--allow-spend <usd>` for creative
engines. See `acuvo-mcp --help`.

## Documentation

| | |
|---|---|
| [docs/STATUS.md](docs/STATUS.md) | What works today, what is gated, and how each claim was measured |
| [CHANGELOG.md](CHANGELOG.md) | Release history |
| [ROADMAP.md](ROADMAP.md) | What is planned |
| [ENTERPRISE.md](ENTERPRISE.md) | Deployment, isolation and audit |

## Contributing

Bug reports and pull requests are welcome. See
[CONTRIBUTING.md](https://github.com/xxiautomate-star/acuvo-code/blob/main/CONTRIBUTING.md), and
report security issues privately as described in
[SECURITY.md](https://github.com/xxiautomate-star/acuvo-code/blob/main/SECURITY.md).

```bash
git clone https://github.com/xxiautomate-star/acuvo-code.git
cd acuvo-code
npm test
```

## License

[Functional Source License 1.1, Apache 2.0 Future License](LICENSE) (`FSL-1.1-ALv2`).

You may use, modify and run Acuvo Code, including inside your company. The license restricts only
offering it as a competing product, and each release converts to Apache 2.0 two years after it is
published.
