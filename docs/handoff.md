# Handoff contract (author ↔ reviewer)

Read when working on how work moves between containers, the review loop, or branch/PR
artifacts.

Author and reviewer are always separate containers and are almost never alive at the same
time. There is **no live channel** between them: all handoff goes through the **git remote**
and the **board**. See [ADR 0004](adr/0004-review-fresh-clone-pinned-sha.md).

## Why a fresh container

Review must verify what was actually pushed, not what happened to be in the author's
working tree. Reusing the author's container would inherit:

- uncommitted or patched files that are not in the commit;
- the author's capability set (wrong for a reviewer);
- the author's context (the opposite of an independent read).

So the reviewer gets a fresh container with a clean clone at a **pinned** commit.

## Roles

| Role | edit/commit | push `feat/*` | run tests | merge `main` | delete branch |
| ---- | ----------- | ------------- | --------- | ------------ | ------------- |
| author | yes | yes | yes | no | no |
| reviewer | no | no | yes | yes | yes |

Enforced by the capability compiler (permissions **and** credential scope), not prompt text.

## Author → reviewer

The author returns a result and never moves the task (see [orchestrator.md](orchestrator.md)):

```
{ status: "done",
  branch,        // feat/<slug>
  head_sha,      // exact commit to review — not "branch head"
  base_sha,      // merge-base against main
  pr_url?,       // if the project uses PRs
  summary }      // becomes the handoff note
```

The orchestrator verifies the remote ref, then transitions the task to `Code Review` with
the note. The reviewer container:

1. clones at `head_sha` (detached, **not** the branch tip);
2. runs build/lint/tests from the clean tree;
3. reviews the diff `base_sha..head_sha`.

## Reviewer → board

```
{ verdict: "approve" | "changes",
  note,                 // required when changes
  pr_review_comments?,
  merge_sha? }          // when approve
```

- `approve` — the reviewer has already merged (it holds the merge credential); the
  orchestrator verifies `merge_sha` is an ancestor of `origin/main` and the feature branch
  is deleted, then moves the task to `Done`.
- `changes` — the orchestrator moves the task to `Changes Requested` with the note and PR
  comments.

## Reverse handoff (`Changes Requested`)

The author instance is gone, so the fix is a **new container** resuming from durable state:

- clone the branch (at the previous `head_sha`);
- inject the reviewer's note + PR comments + acceptance criteria into the prompt;
- fix, push, return a new `head_sha`; the orchestrator moves back to `Code Review`.

### Iteration bound

`review.maxRounds` (default `3` — see [configuration.md](configuration.md)) caps
author↔reviewer rounds per task. Each `changes` verdict increments a counter stored on the
durable task record (board + audit), **not** in any container. When the bound is reached the
orchestrator moves the task to `Need Help` instead of provisioning another author container.

- One round = reviewer `changes` → new author container → reviewer verdict.
- The counter survives teardown and orchestrator restarts (it is task state, not container
  state).

## Reviewer checklist (hard criteria)

- **Tests**: diff test files `base_sha..head_sha`; reject weakened or deleted assertions.
- **Clean tree**: `git status` clean after the test run (a pass must not come from an
  uncommitted patch).
- **Re-run** build/lint/tests yourself — never trust the author's summary.
