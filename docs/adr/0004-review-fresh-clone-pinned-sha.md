# 0004. Reviewers verify a fresh clone at a pinned SHA; feedback is async

Status: accepted
Task: #87

## Context

Containers are ephemeral and per-task, so the author container is usually gone by the time
a review happens. The tempting shortcut — run the reviewer in the author's container, or
review whatever `feat/*` currently points at — silently reviews something other than what
was pushed.

## Decision

The reviewer runs in a **new container** and clones **at the pinned `head_sha`** (detached,
not the branch tip). All author↔reviewer communication goes through the **board note + PR
comments + branch**; there is no live channel. A `Changes Requested` fix is a new container
resuming from the branch. Iterations are bounded (→ `Need Help`).

## Consequences

- Review always targets exactly the commit that will land; a moved branch cannot change what
  was reviewed.
- The reviewer cannot be influenced by leftover working-tree state or the author's context.
- Feedback must be durable and self-contained in the note/PR, since the next author is a
  fresh, amnesiac agent.
- Role privileges must be enforced by the capability compiler (permissions + credentials),
  since there is no shared session to lean on.

## Alternatives rejected

- **Reviewer in the author's container** — inherits uncommitted state, wrong capability set,
  and the author's context; not independent.
- **Review the branch tip** — the branch can move after handoff; the reviewed commit would
  not be the merged one.
- **A live author↔reviewer channel** — impossible given per-task container teardown.
