# Decisions (ADRs)

One file per non-obvious design decision. Read this index, then the specific ADR.

## Rules

- Filename: `NNNN-short-title.md`; `NNNN` is zero-padded and never reused.
- `Status` is one of `proposed` | `accepted` | `superseded by NNNN`.
- Keep each ADR short: Context, Decision, Consequences. Add "Alternatives rejected" only
  when it prevents re-litigating the same decision.
- **Never rewrite or delete history.** To change a decision, write a new ADR and set the
  old one's status to `superseded by NNNN`.
- Record the kanban `Task` id and, once it exists, the commit that introduced the decision.

## Index

| ADR | Decision | Status | Task |
| --- | -------- | ------ | ---- |
| [`0001-one-container-per-task.md`](0001-one-container-per-task.md) | One container per task attempt; cold spawn | accepted | #84 |
| [`0002-capability-compiler.md`](0002-capability-compiler.md) | Compiler is pure, fail-closed, manifest-sourced | accepted | #85 |
| [`0003-orchestrator-owns-board.md`](0003-orchestrator-owns-board.md) | Orchestrator is sole board writer; completion is a validated structured result | accepted | #86 |
| [`0004-review-fresh-clone-pinned-sha.md`](0004-review-fresh-clone-pinned-sha.md) | Reviewer uses a fresh clone at a pinned SHA; feedback is async via board+PR | accepted | #87 |
| [`0005-stream-events-out.md`](0005-stream-events-out.md) | Stream `/event` + stderr out continuously; block destroy until flushed | accepted | #89 |
| [`0006-role-privileges-are-data.md`](0006-role-privileges-are-data.md) | Role policies are data; merge to `main` is reviewer-only | accepted | #88 |
| [`0007-per-container-scoped-tokens.md`](0007-per-container-scoped-tokens.md) | Per-container short-lived scoped tokens; broker separate from compiler | accepted | #90 |
| [`0008-egress-default-deny.md`](0008-egress-default-deny.md) | Egress is default-deny, enforced by a proxy allowlist | accepted | #91 |
