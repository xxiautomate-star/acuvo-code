# Security Policy

## Reporting a vulnerability

**Preferred: GitHub Security Advisories.** Use
[Report a vulnerability](https://github.com/xxiautomate-star/acuvo-code/security/advisories/new)
on this repository. It's private by default — nobody else sees the report until you and the
maintainer agree it's safe to disclose.

**Alternative:** email **roman@xxiautomate.com** (the maintainer contact already published in
this repo's `package.json`) with:

- A description of the vulnerability and its impact.
- Steps to reproduce (a minimal repro is the fastest path to a fix).
- The version of `acuvo-code` affected (`acuvo --version`).

Please **do not** open a public issue for a security report — this CLI runs model-directed
shell commands and file writes on your machine, so a vulnerability report deserves a private
channel first.

## What's in scope

- The CLI itself (`bin/`, `lib/`, `scripts/`) — command injection, path traversal, credential
  leakage, unsafe defaults in the tool-execution sandboxing, or anything that lets a crafted
  prompt or repository escape the intended scope of a run.
- The MCP client/server code (`acuvo-mcp`).
- The published npm package (`acuvo-code`) if the published artifact differs from what the
  source implies.

## What's out of scope

- Vulnerabilities in a third-party model provider (OpenRouter, etc.) reached through this CLI
  — report those to the provider.
- Issues that require the attacker to already have the ability to run arbitrary code as you
  (this CLI is a tool you run locally with your own permissions).

## Response

This is a small, pre-revenue project maintained part-time. There's no formal SLA, but security
reports get priority over everything else in the backlog — expect an initial response within a
few days.

## Supported versions

Only the latest published version on npm is supported. Please update (`npm i -g acuvo-code`)
before reporting, and confirm the issue reproduces on the current version.
