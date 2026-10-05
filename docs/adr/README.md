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
