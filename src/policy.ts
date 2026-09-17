/**
 * pid-worktree agent policy.
 *
 * Keeps the injected system prompt short: facts about where the session is
 * working plus when the model should reach for the worktree tools instead of
 * editing in place. Exactly one "where you are" statement per turn — bound
 * sessions hear about their worktree, never about the origin's children.
 */

export interface PolicyFacts {
  branch: string | null;
  clean: boolean;
  worktreeCount: number;
  /** Session is bound to a worktree it owns (or is standing inside one). */
  bound?: {
    root: string;
    branch: string;
    originBranch: string | null;
    originPath: string;
    /** True when the session cwd is already the worktree (no re-rooting needed). */
    standingInside: boolean;
    task?: string | null;
  } | null;
  childCount?: number;
  childBranches?: string[];
}

export const WORKTREE_GUIDELINES = [
  "Use worktree_status to check git cleanliness before risky edits; use worktree_create to isolate experimental work, worktree_land to merge a linked worktree back, and worktree_abandon to discard one.",
  "When the workspace is CLEAN and the task is experimental, risky, or explicitly parallel, call worktree_create instead of editing in place. The host asks the user to approve and blocks the call if they decline — never raise that question yourself.",
  "Never run raw `git worktree add/remove` shell commands; use the worktree_* tools so origin linkage stays consistent.",
  "When work in a linked worktree is finished, call worktree_land to finish — the host puts the question to the user first, so never land silently and never ask in prose. Write the paragraph they are owed first: what changed, what you verified, what the conclusion is — the card shows the numbers, and no card can say what you decided. Empty worktrees (no commits, clean) are the exception: land/abandon cleans them up immediately with no confirmation needed.",
  "Before calling worktree_create, say in one or two lines what you are isolating, on which branch, and what stays in the origin.",
  "A blocked worktree_* call means the user declined. Stop trying, keep working where the work already is, and say in one line that you stayed.",
  "A bare worktree_land/worktree_abandon means YOUR tree: it resolves this session's own link (or the worktree you're standing in) and never auto-grabs another session's link. Name a branch/path explicitly only to deliberately take one over — then say who owned it and what you did.",
  "Conflicts are yours to resolve with worktree_land: read each conflicted file, keep the intended result from both sides, `git add`, then finish with finish:true. Explain the resolution; ask the user only when both sides look deliberately contradictory.",
  "One active worktree per session per repo: reuse the owned link instead of calling worktree_create again; call worktree_land first when its work is done.",
  "If /worktree arrives with no task text, infer it from the conversation and the dirty files via worktree_status, then create the worktree and do it. Never ask what to work on — when nothing is inferable, still create it and say in one line that it's ready.",
];

function plural(n: number, noun: string): string {
  return n === 1 ? `1 ${noun}` : `${n} ${noun}s`;
}

export function buildPolicySection(f: PolicyFacts): string {
  const lines: string[] = ["## pid-worktree policy (native)"];
  if (f.bound) {
    const b = f.bound;
    const from = b.originBranch ? `\`${b.originBranch}\`` : "its origin";
    lines.push(
      `- Working root: ${b.root} — worktree \`${b.branch}\` forked from ${from} at ${b.originPath}${b.task ? ` for: "${b.task}"` : ""}.`,
    );
    lines.push(
      b.standingInside
        ? "- The session cwd is this worktree; relative paths already resolve here."
        : "- Relative paths and bash commands are re-rooted into the working root automatically — do not prefix `cd`, do not use origin paths for edits (edits under the origin checkout are blocked; reading it for comparison is fine).",
    );
    lines.push(
      "- When the task is done, write the paragraph the user is owed — what changed, what you verified, what the conclusion is — and then call worktree_land. The host shows the user what would land and asks them; a decline comes back as a blocked call, so never ask for approval in prose and never land silently. Empty worktrees (no commits, clean) need no confirmation — land/abandon removes them immediately. To throw non-empty work away, worktree_abandon (the host asks too).",
    );
  } else {
    const where = f.branch ? `branch \`${f.branch}\`` : "detached HEAD";
    lines.push(`- Current worktree: ${where}, ${f.clean ? "CLEAN" : "DIRTY"}, ${plural(f.worktreeCount, "worktree")}.`);
    if ((f.childCount ?? 0) > 0) {
      const kids = (f.childBranches ?? []).slice(0, 5).map((b) => `\`${b}\``).join(", ");
      lines.push(
        `- This is an origin with ${plural(f.childCount ?? 0, "active linked worktree")}${kids ? `: ${kids}` : ""}. Do not edit the same files here in parallel; land children with worktree_land before reusing their branches.`,
      );
    } else if (f.clean) {
      lines.push(
        "- Workspace is CLEAN: ideal for isolation. For experimental/refactor/parallel tasks, call worktree_create (or suggest `/worktree <task>`) before making changes — the host asks the user to approve, so you do not need to. Say in one or two lines what you are isolating and on which branch before you call it.",
      );
    } else {
      lines.push(
        "- Workspace is DIRTY with unrelated changes: do NOT mix a new task into these files. Suggest `/worktree <task>` to isolate, or confirm before touching dirty paths.",
      );
    }
  }
  lines.push("- Never run raw `git worktree add/remove`; use the worktree_* tools so linkage stays consistent.");
  lines.push("- A bare land/abandon means YOUR tree: this session's own link (or the worktree you're standing in). Never auto-grab another session's link; name it explicitly only for a deliberate takeover, then say who owned it.");
  lines.push("- Conflicts are yours to resolve: read, merge sensibly, `git add`, finish with finish:true, explain. Ask only when both sides look deliberately contradictory.");
  return lines.join("\n");
}
