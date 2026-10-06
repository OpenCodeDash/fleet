import type { Action, PermissionValue, Role } from "./types.ts";

type Rule = [string, PermissionValue];

/**
 * Role base policies. Ordered: opencode evaluates permission rules and the *last* matching
 * rule wins, so `"*": "deny"` is prepended by the compiler and hard denials are appended.
 * See docs/capability-compiler.md#role-base-policies and ADR 0006.
 */
export const ROLE_POLICIES: Record<Role, Rule[]> = {
  author: [
    ["read", "allow"],
    ["glob", "allow"],
    ["grep", "allow"],
    ["list", "allow"],
    ["edit", "allow"],
    [
      "bash",
      {
        "*": "ask",
        "git status": "allow",
        "git diff *": "allow",
        "git add *": "allow",
        "git commit *": "allow",
        "git push *": "allow",
        "npm test": "allow",
        "npm run *": "allow",
        "nix *": "allow",
      },
    ],
  ],
  reviewer: [
    ["read", "allow"],
    ["glob", "allow"],
    ["grep", "allow"],
    ["list", "allow"],
    ["edit", "deny"],
    [
      "bash",
      {
        "*": "ask",
        "git merge *": "allow",
        "git push *": "allow",
        "npm test": "allow",
        "npm run *": "allow",
        "nix *": "allow",
      },
    ],
  ],
};

/** Board reads are allowed; the orchestrator owns all writes (ADR 0003). */
export const BOARD_READ_RULES: Rule[] = [
  ["kanban_get_*", "allow"],
  ["kanban_list_*", "allow"],
];

/** Non-overridable denials, appended last so they always win. */
export const HARD_DENY_RULES: Rule[] = [
  ["task", "deny"],
  ["external_directory", "deny"],
  ["webfetch", "deny"],
  ["websearch", "deny"],
  ["kanban_claim_task", "deny"],
  ["kanban_release_task", "deny"],
  ["kanban_move_task", "deny"],
  ["kanban_update_task", "deny"],
  ["kanban_create_*", "deny"],
  ["kanban_delete_*", "deny"],
  ["kanban_rename_*", "deny"],
  ["kanban_reorder_*", "deny"],
  ["kanban_update_*", "deny"],
];

export function isAction(value: unknown): value is Action {
  return value === "allow" || value === "ask" || value === "deny";
}
