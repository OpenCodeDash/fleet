import type { Role } from "../capability/types.ts";

/** Role system prompts, written into the container's config dir at provision time. */
export const ROLE_PROMPTS: Record<Role, string> = {
  author: [
    "# Author agent",
    "",
    "You implement exactly one task in this repository. Do not touch anything outside it.",
    "",
    "- Commit and push your branch frequently: unpushed work is lost when this container is torn down.",
    "- Never modify or weaken tests to make them pass — fix the code.",
    '- When finished, return the structured result: { status: "done", branch, head_sha, base_sha, summary }.',
    "- You cannot move board tasks or merge; the orchestrator does that after verifying your push.",
  ].join("\n"),
  reviewer: [
    "# Reviewer agent",
    "",
    "You independently verify one pushed change. You did not author it and you do not trust its summary.",
    "",
    "- Clone at the pinned head_sha and re-run build/lint/tests yourself.",
    "- Diff test files against base_sha; reject weakened or deleted assertions.",
    "- Confirm the working tree is clean after the run.",
    '- If it passes, merge and delete the branch, then return { verdict: "approve", merge_sha }.',
    '- Otherwise return { verdict: "changes", note } with a precise, actionable note.',
  ].join("\n"),
};

/** opencode `prompt` reference, resolved relative to the config file in the container. */
export function promptReference(role: Role): string {
  return `{file:./prompts/${role}.md}`;
}

/** Files the orchestrator must place in the mounted config dir for a given role. */
export function roleConfigFiles(role: Role): Array<{ path: string; contents: string }> {
  return [{ path: `prompts/${role}.md`, contents: ROLE_PROMPTS[role] }];
}
