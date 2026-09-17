/**
 * The same chrome, for a host that is not a terminal.
 *
 * The status line a terminal sees is assembled with `theme.fg(...)`, which writes raw ANSI escapes
 * unconditionally — `ctx.ui.theme` is the same object in every mode. A graphical host handed that
 * string gets escape bytes, so this publishes the numbers instead and lets the host paint them.
 *
 * Nothing about the terminal path changes: both are built from the same fields, before any colour
 * is applied.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** This extension's name. A widget key is an identity, so the host routes the lines back by it. */
export const BINDING_WIDGET_KEY = "pid-worktree";

export interface BoundWorktree {
  branch: string;
  /** Where `/land` would merge to. */
  dest: string;
  ahead: number;
  behind: number;
  /** Working-tree entries `git status --porcelain` reports. */
  dirty: number;
  /** Files this worktree has that the origin does not — committed and uncommitted together. */
  files: number;
  added: number;
  deleted: number;
  task?: string;
  worktreePath: string;
  originPath: string;
  /** The session is running inside the worktree, rather than owning one from its origin. */
  inside: boolean;
}

/** One file in the card: the same cells the terminal's table pads into columns. */
export interface AskFile {
  /** Raw git status letter (A, M, D, R…). The desktop half maps it to its own badge. */
  status: string;
  path: string;
  /** Lines added/deleted; null for a binary file. */
  added: number | null;
  deleted: number | null;
}

/**
 * A question the agent half is waiting on.
 *
 * Structured rather than painted, because the desktop half composes PID's own primitives from it
 * — the terminal paints the same fields with `diagramTree`/`fileColumns`, so one card has two
 * renderings instead of two cards.
 */
export interface AskCard {
  kind: "create" | "land" | "abandon";
  /** `main -> wt-gate` — the same hero the terminal puts in `【】`. */
  hero: string;
  /** A verb phrase for a land that has not happened: `will rebase`. */
  note?: string;
  /** The one line that says what happens: `carrying 2 of 5 files · 3 left in origin`. */
  summary?: string;
  /** Commits the merge would carry; with it, the file list is headed by its own count. */
  commitCount?: number;
  /** Commit subjects the merge would carry, newest first. */
  commits?: string[];
  /** Files in play. */
  files?: AskFile[];
}

/** The card, plus which tool call raised it — so the transcript row that holds the id draws it. */
export interface PendingAsk extends AskCard {
  /** `toolCallId` of the call this question is blocking. */
  id: string;
  /**
   * Set once the user has answered, and only then: the card keeps its numbers and drops its buttons,
   * so the decision they just made stays where they made it. Cleared when the run it handed back to
   * the model is over — from there the row is a line in the transcript like any other.
   */
  answer?: "yes" | "no";
}

/** Exactly one of these is set, matching the shapes of the terminal line. */
export interface WorktreeWidget {
  /**
   * The session's own worktree. The only shape a window draws: a worktree belongs to the session
   * that opened it, and a summary of everyone else's is noise in someone else's window.
   */
  binding?: BoundWorktree;
  /**
   * The branch the session is on when it has no worktree.
   *
   * Claiming a header mount makes PID stand its own branch chip down, so an extension that renders a
   * header owes that chip back. Nothing more: no counts, no chip, no worktree vocabulary — the same
   * thing PID would have drawn.
   */
  repo?: { branch: string | null };
  /** Set while a worktree-changing call is waiting for the user's answer. */
  ask?: PendingAsk;
}

/** A host that draws, but not in a terminal. `hasUI` alone is true in a terminal too. */
export function wantsWidget(ctx: ExtensionContext): boolean {
  return ctx.hasUI && ctx.mode !== "tui";
}

/**
 * Publish or clear the binding widget. Safe to call in any mode: in a terminal it does nothing, so
 * callers do not have to remember which branch they are on.
 */
export function publishBinding(ctx: ExtensionContext, widget: WorktreeWidget | undefined): void {
  if (!wantsWidget(ctx)) return;
  try {
    ctx.ui.setWidget(BINDING_WIDGET_KEY, widget ? [JSON.stringify(widget)] : undefined);
  } catch {
    // Chrome must never break the session.
  }
}
