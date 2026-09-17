/**
 * The approval gate.
 *
 * A worktree changes where the work lives, so the agent deciding that on its own is a decision the
 * user should see before it happens: the call is stopped at the door and asked about. A command the
 * user typed is not stopped — `/worktree` and `/land` already answered that question, and asking
 * again for a decision just made is noise.
 *
 * One answer per run: a land that hits a conflict asks once, then finishes without asking again.
 * A decline holds for the rest of the run too, so a model that retries cannot re-raise the dialog.
 */

/** The tools this gate covers, and what kind of decision each one is. */
export const GATED_TOOLS = {
  worktree_create: "create",
  worktree_land: "land",
  worktree_abandon: "abandon",
} as const;

export type GateKind = (typeof GATED_TOOLS)[keyof typeof GATED_TOOLS];

/** The kind of decision a tool is, or `undefined` for a tool the gate never touches. */
export function gateKind(toolName: string): GateKind | undefined {
  return toolName in GATED_TOOLS ? GATED_TOOLS[toolName as keyof typeof GATED_TOOLS] : undefined;
}

export interface GateFacts {
  toolName: string;
  /** True when a dialog can be raised at all. Without one the question would hang forever. */
  hasUI: boolean;
  /** The tool's own parameters. `abort` and `confirm` change the answer. */
  params: Record<string, unknown>;
  /**
   * Whether the message carrying this call also says something to the user.
   *
   * The card is drawn *under* the model's own words — that is what makes a decision answerable — so
   * a call with no words in a message with none is a question with nothing above it.
   */
  saidToUser: boolean;
}

export type GateVerdict =
  /** Run it without asking. */
  | "allow"
  /** Stop and ask; the user's answer decides whether the call runs. */
  | "ask"
  /** Declined earlier in this run — block it again without raising a second card. */
  | "deny"
  /** Say what this is about first: no card until the question has words above it. */
  | "explain";

export class Gate {
  /** Kinds of work a user command already authorized. Stays armed until the call it was for. */
  private armed = new Set<GateKind>();
  /** Kinds the user said yes to, for the rest of the run. */
  private yes = new Set<GateKind>();
  /** Kinds the user said no to, for the rest of the run. */
  private no = new Set<GateKind>();
  /** Kinds whose question is already outstanding in the transcript. */
  private open = new Set<GateKind>();
  /** Kinds already sent back once for the paragraph — a nudge, never a loop. */
  private nudged = new Set<GateKind>();

  /** A command the user typed that already is the answer for this kind of work. */
  arm(...kinds: GateKind[]): void {
    for (const k of kinds) this.armed.add(k);
  }

  /**
   * What to do with one call. Every branch that says `allow` is a call that changes nothing the
   * user has not already agreed to; the order puts the cheap, certain answers first.
   */
  decide(f: GateFacts): GateVerdict {
    const kind = gateKind(f.toolName);
    // Not a worktree call at all.
    if (!kind) return "allow";
    // A host with no dialogs (print / json runs) must not hang on a question nobody can answer.
    if (!f.hasUI) return "allow";
    // Aborting a conflicted merge is the undo, not the landing.
    if (f.params.abort === true) return "allow";
    // `confirm:false` is the dry run: it reports what would be lost and deletes nothing.
    if (kind === "abandon" && f.params.confirm !== true) return "allow";
    // The user typed the command themselves: that *is* the answer.
    if (this.armed.delete(kind)) return "allow";
    // One question at a time. A second card would leave the first one unattachable — the buttons
    // answer one question, and a person who is looking at two of them cannot tell which they are
    // answering. The model is told to wait rather than to retry.
    if (this.open.size > 0) return "deny";
    // Already asked, already answered no: a retry is blocked without a second card.
    if (this.no.has(kind)) return "deny";
    if (this.yes.has(kind)) return "allow";
    // The card goes under the model's words, not instead of them. Once per kind per run: a model
    // that ignores the nudge gets its card anyway, because a loop is worse than a quiet card.
    if (!f.saidToUser && !this.nudged.has(kind)) {
      this.nudged.add(kind);
      return "explain";
    }
    return "ask";
  }

  /** The kind whose question is on screen, if any — what the model is told to answer first. */
  openKind(): GateKind | undefined {
    return this.open.values().next().value;
  }

  /** The question is now in front of the user. */
  asked(kind: GateKind): void {
    this.open.add(kind);
  }

  /** The user answered. */
  answered(kind: GateKind, ok: boolean): void {
    this.open.delete(kind);
    (ok ? this.yes : this.no).add(kind);
  }

  /**
   * The run is over, so the next one asks from scratch. Two things survive deliberately: `armed`,
   * because a command the user typed stays theirs even if the model has not acted on it yet, and
   * `open`, because a question still on screen has not been answered just because a run ended.
   */
  reset(): void {
    this.yes.clear();
    this.no.clear();
    this.nudged.clear();
  }
}

/**
 * What the model is told when a *different* worktree question is still unanswered.
 *
 * It is not a refusal and must not read like one: the user has not declined anything, they have not
 * been asked yet about this one.
 */
export function waitingOnOtherReason(open: GateKind, kind: GateKind): string {
  return `Waiting on the user: a question about ${whatFor(open)} is already in the transcript, unanswered. Answer that one first — the call you just made (${whatFor(kind)}) is held until it is answered.`;
}

/**
 * What the model is told when it asks for a decision without first saying what it is about.
 *
 * Nothing has happened and nothing is held: the call is stopped before a card exists, the model keeps
 * its turn, writes the paragraph, and calls again. The first line is what the row shows afterwards
 * (`stoppedText` reads it), so it is written as a record rather than as an instruction.
 */
export function explainFirstReason(kind: GateKind): string {
  const what = whatFor(kind);
  return [
    `Approval held: nothing said to the user about ${what} yet.`,
    `The card is drawn under your own words, so it would have had nothing above it. Write them now — what changed or what you are isolating, what you verified, what the conclusion is — then call again with the same parameters, and the question goes to the user with your paragraph above it.`,
  ].join("\n");
}

/** What the user is told after declining, so the model stops trying and works in place. */
export function deniedReason(kind: GateKind): string {
  const what = whatFor(kind);
  return `The user declined to ${what}. Do not retry; continue where the work already is and say in one line that you stayed.`;
}

/**
 * What the model is told when the question is waiting in the transcript for a click.
 *
 * The first line is the row's remnant after the question is answered and the run is over
 * (`stoppedText` reads it), so it is written as a record of what was asked, true either way. The
 * rest is for the model and never reaches the window: no retry, no prose question — and the recap
 * it owes the reader, which is the one thing the numbers on the card cannot say.
 */
export function awaitingReason(kind: GateKind): string {
  const what = whatFor(kind);
  return [
    `Approval asked: ${what}.`,
    `The question is in the transcript with its own buttons; the answer arrives as the user's next message, so do not retry and do not ask in prose. When it arrives, your next message is where the user reads what changed and what the conclusion is: lead with that paragraph, then re-issue the call.`,
  ].join("\n");
}

function whatFor(kind: GateKind): string {
  return kind === "create"
    ? "open a worktree"
    : kind === "land"
      ? "land this worktree"
      : "abandon this worktree";
}
