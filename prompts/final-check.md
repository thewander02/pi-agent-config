---
description: Run a bounded fresh-context review of the current diff
---

Perform a fresh-context final review of the current diff.

Run independent reviewers in parallel for:
1. correctness and regressions,
2. tests and validation gaps,
3. security, concurrency, and operational risk,
4. unnecessary complexity and scope creep.

Use read-only reviewers. Deduplicate their findings, verify each against the code, fix only valid findings, then rerun affected checks. Stop after at most two review rounds unless the user requests more.
