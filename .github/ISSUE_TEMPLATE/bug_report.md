---
name: Bug report
about: Something in the CLI didn't do what the docs or the output said it would
title: ""
labels: bug
assignees: ""
---

**What happened**
A clear description of the bug.

**What you expected**
What `README.md` / `--help` / the error message led you to expect instead.

**Steps to reproduce**
1. Command run: `acuvo ...`
2. Environment: OS, Node version (`node --version`), `acuvo --version`
3. Minimal repro, if possible (a tiny directory/repo that triggers it)

**`acuvo --doctor` output**
Paste it — it spends nothing and usually narrows down whether this is a config issue or a
real bug.

```
(paste here)
```

**Logs / output**
Relevant stderr, stack trace, or `--json` output. Redact anything sensitive (API keys, repo
contents you don't want public) — this CLI's own audit log does this automatically for its
output, but paste only what you're comfortable sharing in a public issue.

**Additional context**
Anything else that might be relevant (CI vs local, a specific model in the fallback chain,
etc).
