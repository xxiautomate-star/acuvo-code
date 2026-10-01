# Contributing to Acuvo Code

Thanks for looking at the source. A few things before you open a PR.

## Before you write code

- **Open an issue first** for anything bigger than a typo or a one-line fix, so we don't
  duplicate work or build something that doesn't fit the direction in `ROADMAP.md`.
- Read `README.md` and `CHANGELOG.md` — this project documents its own failures and stale
  claims in place rather than deleting them (see "docs decay in both directions" in the
  README). That tone is deliberate; PR descriptions and commit messages should match it: say
  what you measured, not what you hope is true.

## Setup

```bash
git clone https://github.com/xxiautomate-star/acuvo-code.git
cd acuvo-code
node bin/acuvo.mjs --doctor      # no install step — zero dependencies
```

No `npm install` is needed to run the CLI itself; `package.json` has no `dependencies`.

## Running tests

```bash
npm test            # scripts/test.mjs — the project's own runner
npm run test:raw     # node --test directly, if you want raw output
```

A green suite only proves the suite is green — see `MISTAKES.md`-style doctrine in the
project's own README about green tests that were wrong on a real run. If your change touches
a command path, run that command for real, not just the matching test.

## Pull requests

- Keep PRs scoped to one change. Large refactors should start as an issue describing the
  "why" first.
- Add or update a `CHANGELOG.md` entry under `## [Unreleased]` for any user-visible change.
- If you touch a flag or tool the model can call, update the relevant section of `README.md`
  in the same PR — this repo has a documented history of capabilities shipping unwired or
  undocumented, and the rule here is: wire and document in the same commit.
- Tests pass locally (`npm test`) before you open the PR.

## Code style

- Zero runtime dependencies is a project constraint, not a suggestion — don't add an npm
  package to solve something Node's standard library already does.
- Match the existing module shape in `lib/` (plain ESM `.mjs`, no build step).

## Reporting bugs / requesting features

Use the issue templates. For anything that looks like a security issue, see `SECURITY.md`
instead of opening a public issue.

## License

By contributing, you agree your contribution is licensed under the project's license (see
`LICENSE` — Functional Source License 1.1, Apache 2.0 Future License).
