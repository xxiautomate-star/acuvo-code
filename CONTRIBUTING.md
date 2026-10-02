# Contributing to Acuvo Code

Thanks for your interest in improving Acuvo Code.

## Before you start

- For anything larger than a small fix, open an issue first so the approach can be agreed
  before you invest time. Check [ROADMAP.md](ROADMAP.md) to see what is already planned.
- For security issues, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Development setup

```bash
git clone https://github.com/xxiautomate-star/acuvo-code.git
cd acuvo-code
node bin/acuvo.mjs --doctor
```

There is no install or build step: the CLI has zero runtime dependencies and runs directly
from source on Node.js 20 or newer.

## Running tests

```bash
npm test             # the project's test runner
npm run test:raw     # node --test directly
```

If your change affects a command, run that command end to end as well as its tests.

## Pull requests

- Keep each pull request focused on one change.
- Add an entry under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) for user-visible changes.
- Update `--help` text and the README in the same pull request when you add or change a flag.
- Make sure `npm test` passes before requesting review.

## Code style

- No new runtime dependencies. Prefer the Node.js standard library.
- Follow the existing module layout in `lib/`: plain ESM `.mjs` files, no build step.

## License

By contributing, you agree that your contribution is licensed under the project's
[license](LICENSE) (Functional Source License 1.1, Apache 2.0 Future License).
