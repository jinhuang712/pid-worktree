/**
 * What the transcript card says.
 *
 * Kept apart from how PID draws it, because this is the half that can be wrong: a status letter, a
 * tone, a summary, the command a button runs. `ui.tsx` composes PID's primitives over these; the
 * answers live here, where a test can read them without a window.
 */

import type { AskCard, AskFile, PendingAsk, WorktreeWidget } from "./host-widget.ts";

/** PID's badge tone vocabulary — the one `Badge` and `Dot` speak. */
export type Tone = "ok" | "warn" | "danger" | "muted";

export const LABEL: Record<AskCard["kind"], string> = {
  create: "🌲 WORKTREE",
  land: "🌲 LAND",
  abandon: "🗑️ ABANDON",
};

/** A button that says "Yes" says nothing: each kind names its own verb. */
export const CONFIRM: Record<AskCard["kind"], string> = {
  create: "Open it",
  land: "Land it",
  abandon: "Throw it away",
};

export const TITLE: Record<AskCard["kind"], string> = {
  create: "New worktree",
  land: "Land this worktree",
  abandon: "Abandon this worktree",
};

export const KIND_OF: Record<string, AskCard["kind"]> = {
  worktree_create: "create",
  worktree_land: "land",
  worktree_abandon: "abandon",
};

const DONE_VERB: Record<AskCard["kind"], [running: string, done: string]> = {
  create: ["Isolating", "Isolated"],
  land: ["Landing", "Landed"],
  abandon: ["Discarding", "Discarded"],
};

/** The verb on the collapsed row: what this call is doing, in the tense it is doing it. */
export function rowVerb(kind: AskCard["kind"], status: string | undefined): string {
  const [running, done] = DONE_VERB[kind];
  return status === "running" ? running : done;
}

/** Git's status letter as the terminal's table prints it: N new, U updated, D deleted, R renamed. */
export function letter(status: string): string {
  if (status === "A" || status === "C") return "N";
  if (status === "M" || status === "T") return "U";
  if (status === "D") return "D";
  if (status === "R") return "R";
  return status;
}

export function toneOf(status: string): Tone {
  const l = letter(status);
  if (l === "N") return "ok";
  if (l === "D") return "danger";
  if (l === "U" || l === "R") return "warn";
  return "muted";
}

/** `+12` / `−3`, or the one word a binary file gets. */
export function fileNumbers(file: AskFile): { added: string; deleted: string } {
  return {
    added: file.added === null ? "bin" : `+${file.added ?? 0}`,
    deleted: file.deleted === null ? "" : `−${file.deleted ?? 0}`,
  };
}

/** The two buttons, as the commands PID runs for them. */
export function answerCommand(yes: boolean): string {
  return yes ? "/worktree-answer yes" : "/worktree-answer no";
}

/** The question this row is holding, if it is the row that raised it. */
export function askForCall(state: unknown, callId: string): PendingAsk | undefined {
  const ask = (state as WorktreeWidget | undefined)?.ask;
  return ask && ask.id === callId ? ask : undefined;
}

interface ToolRunLike {
  status?: string;
  isError?: boolean;
  result?: { content?: { type?: string; text?: string }[]; details?: unknown };
}

interface CreateDetails {
  ok?: boolean;
  from?: string;
  branch?: string;
  carried?: unknown;
  total?: number;
  changes?: unknown;
}

/**
 * The receipt: the card again, rebuilt from what the tool reported.
 *
 * `undefined` when the call never got as far as reporting a worktree — a blocked call, or an error —
 * which is the row's cue to say one dim line instead of drawing a card.
 */
export function receiptOf(toolName: string, run: ToolRunLike | undefined): AskCard | undefined {
  const kind = KIND_OF[toolName];
  if (!kind || run?.isError === true) return undefined;
  const d = run?.result?.details as CreateDetails | undefined;
  if (!d?.ok || typeof d.branch !== "string") return undefined;

  const files = Array.isArray(d.changes) ? (d.changes as AskFile[]) : [];
  const carried = Array.isArray(d.carried) ? d.carried.length : files.length;
  const total = typeof d.total === "number" ? d.total : carried;

  let summary: string;
  if (kind === "abandon") summary = "discarded";
  else if (kind === "land") summary = `${files.length} ${files.length === 1 ? "file" : "files"} landed`;
  else if (carried === 0) summary = "clean · nothing to carry";
  else if (total > carried) summary = `carrying ${carried} of ${total} files · ${total - carried} left in origin`;
  else summary = `carrying ${carried} ${carried === 1 ? "file" : "files"}`;

  // Land reads `branch -> dest`; the other two are about the branch itself.
  const hero =
    kind === "land"
      ? `${d.from ?? d.branch} -> ${d.branch}`
      : `${d.from ?? "?"} -> ${d.branch}`;
  return { kind, hero, summary, files };
}

/** What a blocked or failed call says: its first line of output, or a plain fallback. */
export function stoppedText(run: ToolRunLike | undefined): string {
  const text = (run?.result?.content ?? [])
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n")
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  return text ?? "No result.";
}

// ---------------------------------------------------------------- the header line

/**
 * What the worktree line says, and everything it had to leave out.
 *
 * Two shapes, and the difference between them is the whole rule: a session with an open worktree
 * gets a chip with its numbers, and a session without one gets the branch PID would have drawn
 * anyway. Nothing else appears here — not another session's worktrees, not a roll-up of the repos
 * under the folder. A worktree belongs to the session that opened it.
 */
export interface WorktreeLine {
  /** `wt-gate → main`, or the plain branch when nothing is open. */
  text: string;
  /** `4 files`, when there is anything to count. */
  files?: string;
  /** `+58` / `−11`, kept apart so a host can tint them. */
  added?: string;
  deleted?: string;
  /** `↑2`, `1 dirty`. */
  bits: string[];
  tone: "warn" | "faint";
  /** Hover detail — the whole picture, when the line had to be shortened. */
  detail: string;
}

/**
 * The worktree line for a session: its own worktree, or nothing worth saying.
 */
export function worktreeLine(state: WorktreeWidget | undefined): WorktreeLine | undefined {
  if (state?.binding) {
    const b = state.binding;
    const bits: string[] = [];
    if (b.ahead) bits.push(`↑${b.ahead}`);
    if (b.behind) bits.push(`↓${b.behind}`);
    if (b.dirty) bits.push(`${b.dirty} dirty`);
    const files = b.files > 0 ? `${b.files} ${b.files === 1 ? "file" : "files"}` : undefined;
    return {
      text: `🌲 ${b.branch} → ${b.dest}`,
      ...(files ? { files } : {}),
      // A zero on either side is worth showing once there is a diff at all: `+58 −0` says the work
      // has no deletions, which a missing `−0` would not.
      ...(files ? { added: `+${b.added}`, deleted: `−${b.deleted}` } : {}),
      bits,
      tone: "warn",
      detail: [b.task, `${b.branch} → ${b.dest}`].filter(Boolean).join(" · "),
    };
  }

  // Nothing open: the branch, and only the branch. A worktree is the session's own business, so a
  // session without one has nothing here to say — and a summary of other sessions' worktrees, or of
  // every repo under the folder, is noise in someone else's window.
  const repo = state?.repo;
  if (!repo) return undefined;
  return {
    text: repo.branch ?? "detached",
    bits: [],
    tone: "faint",
    detail: repo.branch ?? "detached HEAD",
  };
}
