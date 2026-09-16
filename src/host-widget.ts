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
  task?: string;
  worktreePath: string;
  originPath: string;
  /** The session is running inside the worktree, rather than owning one from its origin. */
  inside: boolean;
}

export interface ChildWorktree {
  branch: string;
  worktreePath: string;
}

/** Exactly one of these is set, matching the two shapes of the terminal line. */
export interface WorktreeWidget {
  binding?: BoundWorktree;
  children?: ChildWorktree[];
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
