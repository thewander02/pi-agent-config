---
description: Independently verify the current work and report evidence
---

Verify the current work without trusting earlier claims.

- Inspect the actual diff and repository status.
- Derive the required checks from repository instructions and changed components.
- Run the narrowest relevant tests, lint, type checks, formatting checks, and build checks.
- Do not modify unrelated code merely to make checks green.
- Separate new failures from pre-existing failures with evidence.
- Return a compact verification table: command, result, and what it proves.
