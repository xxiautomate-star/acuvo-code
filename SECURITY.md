# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/xxiautomate-star/acuvo-code/security/advisories/new).
Reports are visible only to you and the maintainers until a fix is agreed.

Alternatively, email **roman@xxiautomate.com**. Please include:

- A description of the issue and its impact.
- Steps to reproduce, ideally a minimal example.
- The affected version (`acuvo --version`).

Do not open a public issue for security reports. Acuvo Code runs commands and writes files on
your machine, so reports deserve a private channel first.

## Scope

In scope:

- The CLI (`bin/`, `lib/`, `scripts/`): command injection, path traversal, credential leakage,
  sandbox or permission bypasses, or any way a crafted prompt or repository can escape the
  intended scope of a run.
- The MCP server and client (`acuvo-mcp`).
- The published npm package, if it differs from the source in this repository.

Out of scope:

- Vulnerabilities in third-party model providers reached through the CLI.
- Issues that require an attacker to already run arbitrary code as you.

## Response

We aim to acknowledge reports within a few business days and prioritise security fixes over
other work.

## Supported versions

Only the latest version published to npm is supported. Please confirm the issue reproduces on
the current release (`npm i -g acuvo-code`) before reporting.
