# 0006. Role privileges are compiler data; merge is reviewer-only

Status: accepted
Task: #88

## Context

Author and reviewer must have different powers, but an agent cannot be trusted to respect
its own role from prompt text alone. Roles also need tuning per repository without weakening
the review guarantee.

## Decision

Role base policies are **data** in the capability compiler — built-in defaults, overridable
per repo — enforced in two places: the `permission` tree (may the shell run `git`?) and the
credential scope (what may the push touch?). One privilege is a **floor and is not
overridable**: only the reviewer role may merge to `main` or delete a feature branch.

## Consequences

- A repo can adjust author/reviewer tool access but cannot grant merge to an author role.
- The same fact lives in two enforcement points by necessity (permission gates the command,
  the token gates the target); both must agree.
- Reviewers can always merge; authors can never self-merge — independent of prompt quality.

## Alternatives rejected

- **Prompt-only roles** — an agent can ignore instructions; no enforcement.
- **Permission-only roles** — `permission` cannot express git-remote target scope.
- **Credential-only roles** — does not stop the agent from *attempting* writes it lacks
  rights for, only the outcome.
