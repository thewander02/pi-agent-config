---
description: Debug a failure with a hypothesis-driven loop
argument-hint: <problem or failing command>
---

Investigate $@ using a hypothesis-driven loop.

1. Reproduce or establish the failure from observed evidence.
2. Identify the smallest set of plausible causes.
3. Test the highest-signal hypothesis before editing.
4. Fix the root cause with the narrowest complete change.
5. Add or update a regression test when practical.
6. Run targeted validation, then the relevant aggregate check.
7. Report evidence, changed files, and remaining uncertainty.
