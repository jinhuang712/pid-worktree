/**
 * pid-worktree — native git worktree flow for pi.
 *
 * Two user commands, everything else belongs to the model:
 * - `/worktree [task]` isolates work into a new worktree, binds the session
 *   to it (tool calls are re-rooted there) and hands the task to the agent.
 * - `/land` shows what would land, lets you pick rebase→ff / squash / merge,
 *   merges the worktree back into its origin and cleans up.
 * - Status, abandon, conflict continuation and strategy details live in the
 *   worktree_* tools + policy, not in user-facing flags.
 *
 * Linkage is stored per link in `<git-common-dir>/pid-worktree/` so it
 * survives `cd` + fresh sessions on either side, plus session entries for
 * the current branch view.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { rewriteToolInput, type Binding } from "./bind.ts";
import { worktreeLine } from "./ask-view.ts";
import { diagramTree, fileColumns, type DiagramRow } from "./card.ts";
import { Gate, awaitingReason, deniedReason, explainFirstReason, gateKind, waitingOnOtherReason, type GateKind } from "./gate.ts";
import { publishBinding, type AskCard, type PendingAsk } from "./host-widget.ts";
import {
  abortMerge,
  aheadBehind,
  branchExists,
  carryChangesViaStash,
  collectFacts,
  commitSubjects,
  createWorktree,
  dedupePath,
  defaultWorktreePath,
  deleteBranch,
  diffChanges,
  diffStat,
  ensureCommitted,
  getCommonDir,
  getCurrentBranch,
  getStatusPorcelain,
  getTopLevel,
  hasMergeHead,
  isDetached,
  isWorkTree,
  listWorktrees,
  worktreeChanges,
  worktreeStat,
  mergeInto,
  porcelainPaths,
  pruneWorktrees,
  refExists,
  removeWorktree,
  resolveUniqueBranch,
  sanitizeBranchName,
  suggestBranchName,
  syncStoreWithGit,
  unmergedFiles,
  workingChanges,
  type DiffStat,
  type ExecFn,
  type FileChange,
  type LandStrategy,
} from "./git.ts";
import { buildPolicySection } from "./policy.ts";
import {
  activeLinkFor,
  canonicalPath,
  childrenOf,
  findByWorktree,
  foreignOwnerOf,
  loadStore,
  loadPrefs,
  makeId,
  orderKidsForDisplay,
  ownerLabel,
  ownActiveLink,
  saveLink,
  savePrefs,
  samePath,
  validStrategy,
  visibleKidsFor,
  type WorktreeLink,
  type WorktreeStore,
} from "./state.ts";

const WIDGET_KEY = "pid-worktree";
const STATUS_KEY = "pid-worktree";
const CARD_TYPE = "pid-worktree";
/**
 * The `customType` this extension wrote before it was renamed. Cards already in a session file
 * carry it, and a renderer is looked up by exact type — so the old name stays registered and those
 * transcripts keep drawing. Nothing new is ever written under it.
 */
const LEGACY_CARD_TYPE = "pi-worktree";
const LINK_ENTRY = "pid-worktree-link";
const EVENT_ENTRY = "pid-worktree-event";

type Strategy = LandStrategy;
const DEFAULT_STRATEGY: Strategy = "rebase";

// ------------------------------------------------------------------ helpers

function makeExec(pi: ExtensionAPI, signal?: AbortSignal): (cwd: string) => ExecFn {
  return (cwd: string) => (cmd, args, opts) =>
    pi.exec(cmd, args, { signal, timeout: opts?.timeout, cwd: opts?.cwd ?? cwd });
}

function pluralWorktree(n: number): string {
  return n === 1 ? "1 worktree" : `${n} worktrees`;
}

function truncateMiddle(s: string, max = 60): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function shortSha(sha: string | null | undefined): string {
  if (!sha) return "unknown";
  return sha.slice(0, 7);
}

/** Visible in every mode: TUI/RPC via notify, print/json via stdout. */
function emit(ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) {
    ctx.ui.notify(text, level);
    return;
  }
  (level === "error" ? console.error : console.log)(text);
}

/**
 * Whether the newest thing in the session is the model talking to the user.
 *
 * The call being gated rides in an assistant message, and Pi has already written that message to the
 * session by the time a tool runs — so "the last message is the model's, and it says something" is
 * the same question as "does this call carry words for the user". Anything else at the tail (a tool
 * result, a user message, nothing at all) means the model went straight from work to a decision.
 */
function saidToUser(ctx: ExtensionContext): boolean {
  try {
    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i] as { type?: string; message?: { role?: string; content?: unknown } };
      if (e?.type !== "message" || !e.message) continue;
      if (e.message.role !== "assistant") return false;
      const content = Array.isArray(e.message.content) ? e.message.content : [];
      return content.some(
        (c) => (c as { type?: string; text?: string })?.type === "text" && ((c as { text?: string }).text ?? "").trim() !== "",
      );
    }
  } catch {
    // A session whose entries cannot be read must not block a call: this is a bedside manner check,
    // not a safety one.
  }
  return true;
}

/** Load linkage self-healed against `git worktree list`; falls back to the raw
 *  store when git is unavailable so reads never break. */
async function loadSyncedStore(exec: ExecFn, cwd: string, commonDir: string): Promise<WorktreeStore> {
  try {
    return await syncStoreWithGit(exec, cwd, commonDir);
  } catch {
    return loadStore(commonDir);
  }
}

/** First line of the task, trimmed to a commit-subject length. */
function subjectFromTask(task: string | null | undefined, fallback: string): string {
  const first = (task ?? "").split("\n").map((s) => s.trim()).find(Boolean) ?? "";
  return first ? truncateMiddle(first, 72) : fallback;
}

/** `/worktree` grammar: every positional is task text; the branch is `--branch`. */
function parseWorktreeArgs(raw: string): {
  branch?: string;
  base?: string;
  path?: string;
  carry: boolean;
  json: boolean;
  yes: boolean;
  help: boolean;
  task: string;
} {
  // Tokens with their offsets, so the task can be cut out of the raw string instead of rebuilt
  // from tokens: it is a prompt the user typed, and joining words back together flattens their
  // line breaks and their whole `<attachments>` block onto one line.
  const tokens: { text: string; start: number; end: number }[] = [];
  for (const m of raw.matchAll(/\S+/g)) {
    const start = m.index ?? 0;
    tokens.push({ text: m[0], start, end: start + m[0].length });
  }
  const flags: [number, number][] = [];
  let branch: string | undefined;
  let base: string | undefined;
  let path: string | undefined;
  let carry = true;
  let json = false;
  let yes = false;
  let help = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].text;
    /** A flag and the value it ate, if any: both leave the task. */
    const cut = (withValue: boolean) => {
      flags.push([tokens[i].start, tokens[withValue && i + 1 < tokens.length ? i + 1 : i].end]);
      if (withValue) i++;
    };
    if (t === "--no-carry") {
      carry = false;
      cut(false);
    } else if (t === "--json") {
      json = true;
      cut(false);
    } else if (t === "--yes" || t === "-y") {
      yes = true;
      cut(false);
    } else if (t === "--help" || t === "-h") {
      help = true;
      cut(false);
    } else if (t === "--branch" || t === "-b") {
      const value = tokens[i + 1];
      if (value) {
        branch = value.text;
        cut(true);
      } else cut(false);
    } else if (t.startsWith("--branch=")) {
      branch = t.slice("--branch=".length);
      cut(false);
    } else if (t === "--base") {
      const value = tokens[i + 1];
      if (value) {
        base = value.text;
        cut(true);
      } else cut(false);
    } else if (t.startsWith("--base=")) {
      base = t.slice("--base=".length);
      cut(false);
    } else if (t === "--path") {
      const value = tokens[i + 1];
      if (value) {
        path = value.text;
        cut(true);
      } else cut(false);
    } else if (t.startsWith("--path=")) {
      path = t.slice("--path=".length);
      cut(false);
    } else if (t.startsWith("--")) {
      cut(false); // a flag this grammar does not know
    }
  }
  let task = "";
  let cursor = 0;
  for (const [start, end] of flags) {
    task += raw.slice(cursor, start);
    cursor = end;
  }
  task += raw.slice(cursor);
  return { branch, base, path, carry, json, yes, help, task: task.trim() };
}

/** `/land [target] [--strategy rebase|merge|squash]` — everything optional.
 *  An explicit --strategy wins for this run and becomes the remembered default. */
function parseLandArgs(raw: string): {
  target?: string;
  strategy?: Strategy;
  badStrategy?: string;
  help: boolean;
} {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  let target: string | undefined;
  let strategy: Strategy | undefined;
  let badStrategy: string | undefined;
  let help = false;
  const takeStrategy = (s: string) => {
    if (validStrategy(s)) strategy = s;
    else if (badStrategy === undefined) badStrategy = s;
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--help" || t === "-h") help = true;
    else if (t === "--strategy" && tokens[i + 1]) takeStrategy(tokens[++i]);
    else if (t.startsWith("--strategy=")) takeStrategy(t.slice("--strategy=".length));
    else if (!t.startsWith("--") && target === undefined) target = t;
  }
  return { target, strategy, badStrategy, help };
}

function formatWorktreeList(
  topLevel: string,
  branch: string | null,
  clean: boolean,
  porcelain: string,
  worktrees: { path: string; branch: string | null; bare?: boolean; detached?: boolean }[],
  originOfCurrent?: WorktreeLink,
  kids: WorktreeLink[] = [],
  me?: string | null,
  bound?: Binding | null,
): string {
  const lines = [
    `Repo: ${topLevel}`,
    `Current: ${branch ?? "(detached)"} ${clean ? "CLEAN" : "DIRTY"}`,
  ];
  if (bound) lines.push(`Bound worktree (this session): ${bound.branch} @ ${bound.root} — tool calls are re-rooted there.`);
  if (!clean) {
    const files = porcelain.split("\n").filter(Boolean);
    lines.push(`Dirty files (${files.length}):`);
    for (const f of files.slice(0, 15)) lines.push(`  ${f}`);
    if (files.length > 15) lines.push(`  … ${files.length - 15} more`);
  }
  lines.push(`Worktrees (${worktrees.length}):`);
  for (const w of worktrees) {
    const label = w.branch ?? (w.detached ? "(detached)" : w.bare ? "(bare)" : "?");
    lines.push(`  ${label}  ${w.path}`);
  }
  if (originOfCurrent && originOfCurrent.status === "active") {
    const tag = ownerLabel(originOfCurrent, me);
    lines.push(`Linked origin: ${originOfCurrent.originBranch ?? "?"} @ ${originOfCurrent.originPath}${tag ? ` ${tag}` : ""}`);
  }
  if (kids.length > 0) {
    lines.push(`Linked children (${kids.length}):`);
    for (const k of kids) {
      const tag = ownerLabel(k, me);
      lines.push(`  ${k.branch}  ${k.worktreePath}${tag ? ` ${tag}` : ""}${k.task ? `  — ${truncateMiddle(k.task, 50)}` : ""}`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------- extension

export default function (pi: ExtensionAPI) {
  const getExec = (cwd: string, signal?: AbortSignal): ExecFn => makeExec(pi, signal)(cwd);

  /** Session ↔ worktree binding, refreshed at session start, before every
   *  agent run, and after create/land/abandon. Null = not bound. */
  let binding: (Binding & { standingInside: boolean; task?: string | null }) | null = null;

  /** The approval gate for worktree-changing tool calls the agent started on its own. */
  const gate = new Gate();
  /**
   * The question a window is drawing in the transcript, waiting for a click — with the call it is
   * holding, so a yes can hand the model back exactly what it asked for.
   */
  let pendingAsk: { card: PendingAsk; toolName: string; params: Record<string, unknown> } | null = null;

  async function resolveBinding(exec: ExecFn, cwd: string, me: string | null | undefined): Promise<typeof binding> {
    const facts = await collectFacts(exec, cwd);
    if (!facts || !facts.commonDir) return (binding = null);
    const canon = await canonicalPath(facts.topLevel);
    const store = await loadSyncedStore(exec, cwd, facts.commonDir);
    const inside = activeLinkFor(store, canon);
    const link = inside ?? ownActiveLink(store, canon, me);
    if (!link) return (binding = null);
    binding = {
      root: link.worktreePath,
      origin: link.originPath,
      branch: link.branch,
      originBranch: link.originBranch,
      linkId: link.id,
      standingInside: !!inside,
      task: link.task ?? null,
    };
    return binding;
  }

  async function recordEvent(data: Record<string, unknown>): Promise<void> {
    try {
      pi.appendEntry(EVENT_ENTRY, data);
    } catch {
      // Non-fatal.
    }
  }

  // ------------------------------------------------------------------ chrome

  /**
   * Widget + footer + terminal title. Bound sessions see one line that says
   * where they are and whether the worktree is ready to land:
   *   🌲 wt-fix-login → main · ↑3 · ↓1 · 2 dirty
   * Origins with children see their own/unowned children. Chrome never throws.
   *
   * The painted line and the status belong to a terminal; a host that is not one gets the same
   * fields as JSON (`publishBinding`) and paints them itself — handing it the escape-coded string
   * as well would show the same thing twice, once as bytes it has to strip.
   */
  async function refreshChrome(ctx: ExtensionContext, cwd: string): Promise<void> {
    try {
      const tui = ctx.mode === "tui";
      const exec = makeExec(pi, ctx.signal ?? undefined)(cwd);
      const facts = await collectFacts(exec, cwd);
      // An open question rides along with whichever shape the chrome takes: it is the only thing a
      // window must keep drawing when the session is not bound to anything yet.
      const ask = pendingAsk ? { ask: pendingAsk.card } : {};
      // The theme paints the terminal's line and status. A window paints its own chrome and its
      // host may carry no terminal theme at all, so asking for one outside a terminal is both
      // pointless and fatal: this used to throw before anything was published.
      const paint = (color: ThemeColor, s: string): string => {
        if (!tui) return s;
        try {
          return ctx.ui.theme.fg(color, s);
        } catch {
          return s;
        }
      };
      const clear = () => {
        if (tui) {
          ctx.ui.setWidget(WIDGET_KEY, undefined);
          ctx.ui.setStatus(STATUS_KEY, undefined);
        }
        publishBinding(ctx, pendingAsk ? ask : undefined);
      };
      if (!facts) return clear();
      const canon = await canonicalPath(facts.topLevel);
      const store = facts.commonDir ? await loadSyncedStore(exec, cwd, facts.commonDir) : null;
      const me = ctx.sessionManager.getSessionId();
      const inside = store ? activeLinkFor(store, canon) : undefined;
      const owned = store ? ownActiveLink(store, canon, me) : undefined;
      const link = inside ?? owned;

      if (link) {
        const dest = link.originBranch ?? "origin";
        const wtFacts = inside ? facts : await collectFacts(exec, link.worktreePath);
        const dirty = wtFacts ? wtFacts.porcelain.split("\n").filter(Boolean).length : 0;
        const ab = link.originBranch
          ? await aheadBehind(exec, link.worktreePath, link.originBranch, "HEAD")
          : { ahead: 0, behind: 0 };
        // How much work the worktree holds, committed and uncommitted together — the number a
        // person watching the chip expects to move.
        const stat = link.originBranch
          ? await worktreeStat(exec, link.worktreePath, link.originBranch)
          : { files: 0, insertions: 0, deletions: 0 };
        const bits: string[] = [];
        if (ab.ahead) bits.push(paint("success", `↑${ab.ahead}`));
        if (ab.behind) bits.push(paint("warning", `↓${ab.behind}`));
        if (dirty) bits.push(paint("warning", `${dirty} dirty`));
        if (!ab.ahead && !dirty) bits.push(paint("dim", "nothing to land yet"));
        const head = paint("accent", `🌲 ${link.branch} → ${dest}`);
        const task = link.task ? paint("dim", ` · ${truncateMiddle(link.task, 36)}`) : "";
        publishBinding(ctx, {
          binding: {
            branch: link.branch,
            dest,
            ahead: ab.ahead,
            behind: ab.behind,
            dirty,
            files: stat.files,
            added: stat.insertions,
            deleted: stat.deletions,
            ...(link.task ? { task: link.task } : {}),
            worktreePath: link.worktreePath,
            originPath: link.originPath,
            inside: inside !== undefined,
          },
          ...ask,
        });
        if (tui) {
          const statBits = stat.files > 0 ? [`${stat.files} files`, `+${stat.insertions}`, `−${stat.deletions}`] : [];
          ctx.ui.setWidget(WIDGET_KEY, [[head, task.trim(), ...bits, ...statBits].filter(Boolean).join(" · ")]);
          ctx.ui.setStatus(STATUS_KEY, paint("accent", `🌲 ${link.branch}`) + (ab.ahead ? paint("dim", ` ↑${ab.ahead}`) : ""));
        }
        try { ctx.ui.setTitle(`🌲 ${link.branch}`); } catch { /* optional */ }
        return;
      }

      const kids = store ? childrenOf(store, canon) : [];
      const visible = orderKidsForDisplay(visibleKidsFor(kids, me, canon), me);
      if (visible.length === 0) {
        // No worktree of this session's own. A window gets the branch back — the chip PID stood
        // down when this extension claimed the header — and nothing else; the terminal keeps the
        // widget line it has always had.
        if (!tui) {
          publishBinding(ctx, { repo: { branch: facts.branch }, ...ask });
          return;
        }
        const dirty = facts.porcelain.split("\n").filter(Boolean).length;
        ctx.ui.setWidget(WIDGET_KEY, [`${paint("dim", `on ${facts.branch ?? "detached"}`)}${dirty ? paint("warning", ` · ${dirty} dirty`) : ""}`]);
        ctx.ui.setStatus(STATUS_KEY, undefined);
        return;
      }
      const shown = visible.slice(0, 3).map((k) => k.branch).join(" · ");
      const more = visible.length > 3 ? ` +${visible.length - 3}` : "";
      if (!tui) {
        publishBinding(ctx, { repo: { branch: facts.branch }, ...ask });
      }
      if (tui) {
        ctx.ui.setWidget(WIDGET_KEY, [`${paint("accent", `🌲 ${pluralWorktree(visible.length)}`)} ${paint("dim", `· ${shown}${more}`)}`]);
        ctx.ui.setStatus(STATUS_KEY, paint("accent", `🌲 ${visible.length}`));
      }
    } catch {
      // Chrome must never break the session.
    }
  }

  // Transcript visual language: every pid-worktree block is purple
  // (toolPendingBg). A caps LABEL plus the hero in 【】 lead; rows hang off a
  // dim `├─`/`└─`/`│` diagram tree (counts and names readable, conflict files
  // brightest — they need action). Emoji mark the
  // family: 🌲 worktree ops, ⚠️ conflicts, 🗑️ abandon, ❌ errors.
  // Cards signal state changes with the smallest effective payload —
  // explanations and decisions belong to the model's own words, and full
  // output is one expand away.
  interface CheckpointInfo {
    branch: string;
    side: "source" | "target";
    paths: string[];
    subject: string;
  }

  interface LandView {
    ok: boolean; branch: string; dest: string; strategy: string; sha: string | null;
    ahead?: number; stat?: DiffStat; names?: string[]; subjects?: string[]; changes?: FileChange[];
    checkpoints?: CheckpointInfo[]; kept?: string | null; finished?: boolean;
    conflicted?: string[]; reason?: string;
    /** True when there was nothing to merge (0 commits, clean). */
    empty?: boolean;
    /** True when the empty worktree was auto-removed. */
    cleaned?: boolean;
  }

  type CardDetails =
    | { kind: "create"; from: string; branch: string; carried: string[]; total: number; selective: boolean; clean: boolean; changes?: FileChange[] }
    | ({ kind: "land" } & LandView)
    | { kind: "abandon"; ok: boolean; branch: string; commits: number; dirty: number; reason?: string }
    | { kind: "error" };

  /** worktree_status stays fully silent: pure triage plumbing, the model
   *  speaks for it when anything is worth saying. */
  function silentRender() {
    return new Container();
  }

  /** Cards clip by cells, not code points, so CJK subjects stop wrapping
   *  mid-sentence on a normal terminal. */
  const TREE_MAX_CELLS = 72;
  const clip = (s: string) => truncateToWidth(s, TREE_MAX_CELLS, "…");

  /** Cells a diagram child line spends before its text: indent 3 + stem 3 +
   *  glyph 2 + space 1. Wrapped continuations line up under the text. */
  const CARD_CHILD_CELLS = 9;

  /** One child, wrapped to the cells left on the card — nothing is hidden,
   *  long subjects continue on the next line instead. */
  function wrapChild(text: string, width: number): string[] {
    const budget = Math.max(16, width - CARD_CHILD_CELLS);
    return visibleWidth(text) <= budget ? [text] : wrapTextWithAnsi(text, budget);
  }

  /** The purple card shell. `build` gets the width the content may use, so
   *  cards wrap to the real terminal instead of a guessed budget. */
  function cardBox(paddingX: number, bg: (s: string) => string, build: (width: number) => string): Component {
    const box = new Box(paddingX, 1, bg);
    box.addChild({
      render: (width: number): string[] => {
        const out: string[] = [];
        for (const line of build(width).split("\n")) {
          if (visibleWidth(line) <= width) out.push(line);
          // Last resort for lines the builders could not wrap themselves.
          else out.push(...wrapTextWithAnsi(line, width));
        }
        return out;
      },
      invalidate: (): void => {},
    });
    return box;
  }

  /** Status column: N new, U updated, D deleted, R renamed (git A/M/D/R). */
  function statusLetter(status: string): string {
    switch (status) {
      case "A": case "C": return "N";
      case "M": case "T": return "U";
      case "D": return "D";
      case "R": return "R";
      default: return status;
    }
  }

  function statusColor(status: string): ThemeColor {
    switch (status) {
      case "A": case "C": return "success";
      case "D": return "error";
      case "R": return "accent";
      case "M": case "T": return "warning";
      default: return "text";
    }
  }

  /** File children as a table: status letter, path, `+N`, `-N` — every row
   *  listed (no cap) and aligned, counts green/red when they move. The path
   *  column shrinks to the card so the counts never wrap. */
  function fileLines(changes: FileChange[] | undefined, names: string[] | undefined, ink: CardInk, width: number): string[] {
    const list = changes ?? [];
    if (list.length === 0) return (names ?? []).map((f) => ink.text(clip(f)));
    const pathMax = Math.max(16, Math.min(56, width - CARD_CHILD_CELLS - 15));
    const cols = fileColumns(list, pathMax);
    return list.map((c, i) => {
      const letter = ink.fg(statusColor(c.status), statusLetter(c.status));
      const added = ink.fg(c.added ? "toolDiffAdded" : "dim", cols[i].added);
      const deleted = ink.fg(c.deleted ? "toolDiffRemoved" : "dim", cols[i].deleted);
      return `${letter}  ${ink.text(cols[i].path)}  ${added}  ${deleted}`;
    });
  }

  function count(noun: string, n: number): string {
    return `${n} ${noun}${n === 1 ? "" : "s"}`;
  }

  function firstLine(full: string): string {
    return full.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  }

  interface CardInk {
    hero: (s: string) => string;
    dim: (s: string) => string;
    error: (s: string) => string;
    text: (s: string) => string;
    fg: (color: ThemeColor, s: string) => string;
  }

  /** One ink palette for every card: accent hero, dim chrome, readable names. */
  function makeInk(theme: Theme): CardInk {
    return {
      hero: (s: string) => theme.fg("accent", theme.bold(s)),
      dim: (s: string) => theme.fg("dim", s),
      error: (s: string) => theme.fg("error", s),
      text: (s: string) => theme.fg("text", s),
      fg: (color: ThemeColor, s: string) => theme.fg(color, s),
    };
  }

  function worktreeText(d: { from: string; branch: string; carried: string[]; total: number; selective: boolean; clean: boolean; changes?: FileChange[] }, ink: CardInk, width: number): string {
    const head = `🌲 WORKTREE ${ink.hero(`【${d.from} -> ${d.branch}】`)}`;
    if (d.clean) {
      return [head, ...diagramTree([{ head: ink.dim("clean · nothing to carry") }], ink.dim)].join("\n");
    }
    const summary = d.carried.length === 0
      ? "nothing carried"
      : d.selective
        ? `carrying ${d.carried.length} of ${d.total} files · ${d.total - d.carried.length} left in origin`
        : `carrying ${count("file", d.carried.length)}`;
    const rows: DiagramRow[] = [{ head: ink.dim(summary), children: fileLines(d.changes, d.carried, ink, width) }];
    return [head, ...diagramTree(rows, ink.dim)].join("\n");
  }

  /** `3 commits` — the count is the signal, the noun is chrome. */
  function treeHead(n: number, noun: string, ink: CardInk): string {
    return `${ink.text(String(n))} ${ink.dim(n === 1 ? noun : `${noun}s`)}`;
  }

  /** `rebase · 517fce9` left both tokens dangling — a verb says what happened
   *  and `as <sha>` names the commit the target now points at. */
  function landMeta(d: LandView): string {
    const verb = d.strategy === "squash" ? "squashed" : d.strategy === "merge" ? "merged" : "rebased";
    return d.sha ? `${verb} as ${shortSha(d.sha)}` : verb;
  }

  function landText(d: LandView, ink: CardInk, full: string, width: number): string {
    const hero = ink.hero(`【${d.branch} -> ${d.dest}】`);
    if (!d.ok && d.reason === "conflict") {
      const files = d.conflicted ?? [];
      const rows: DiagramRow[] = [{ head: ink.dim(count("file", files.length)), children: files.map((f) => clip(f)) }];
      return [`⚠️ LAND CONFLICT ${hero}`, ...diagramTree(rows, ink.dim)].join("\n");
    }
    if (!d.ok && d.reason === "nothing-to-land") {
      return [`🌲 LAND ${hero}`, ...diagramTree([{ head: ink.dim("nothing new · nothing to clean") }], ink.dim)].join("\n");
    }
    if (!d.ok) return ink.error(`❌ ${firstLine(full)}`);
    if (d.empty) {
      const note = d.cleaned ? "nothing new · cleaned up" : "nothing new";
      return `🌲 LAND ${hero} ${ink.dim(`· ${note}`)}`;
    }
    const meta = landMeta(d);
    const rows: DiagramRow[] = [];
    if (d.finished) rows.push({ head: ink.dim("merge concluded") });
    if (d.ahead !== undefined) {
      rows.push({ head: treeHead(d.ahead, "commit", ink), children: (d.subjects ?? []).map((s) => wrapChild(ink.text(s), width)) });
    }
    if (d.stat) {
      rows.push({ head: treeHead(d.stat.files, "file", ink), children: fileLines(d.changes, d.names, ink, width) });
    }
    // The source checkpoint is redundant here: its files are the landed files
    // and its subject is the land message already listed above. Only the
    // origin's own checkpoint is news.
    for (const c of (d.checkpoints ?? []).filter((c) => c.side !== "source")) {
      rows.push({ head: ink.dim(`${count("file", c.paths.length)} checkpointed on ${c.branch}`) });
    }
    if (d.kept) rows.push({ head: ink.dim(clip(d.kept)) });
    return [`🌲 LAND ${hero}${meta ? ` ${ink.dim(`· ${meta}`)}` : ""}`, ...diagramTree(rows, ink.dim)].join("\n");
  }

  function abandonText(d: { branch: string; commits: number; dirty: number }, ink: CardInk, _width: number): string {
    const bits: string[] = [];
    if (d.commits) bits.push(count("commit", d.commits));
    if (d.dirty) bits.push(count("dirty file", d.dirty));
    const note = bits.length ? `${bits.join(" · ")} discarded` : "nothing discarded";
    return [`🗑️ ABANDON ${ink.hero(`【${d.branch}】`)}`, ...diagramTree([{ head: ink.dim(note) }], ink.dim)].join("\n");
  }

  /** The card palette, with the paint removed.
   *
   *  A dialog body is text the host draws, so the same tree reaches it as characters: theme
   *  methods write ANSI unconditionally, and escapes in a window are literal noise. */
  const plainInk: CardInk = {
    hero: (s) => s,
    dim: (s) => s,
    error: (s) => s,
    text: (s) => s,
    fg: (_color, s) => s,
  };

  const GATE_TITLES: Record<GateKind, string> = {
    create: "🌲 New worktree?",
    land: "🌲 Land this worktree?",
    abandon: "🌲 Abandon this worktree?",
  };

  /** The hero label each kind wears, in the terminal and in a window alike. */
  const GATE_LABELS: Record<GateKind, string> = {
    create: "🌲 WORKTREE",
    land: "🌲 LAND",
    abandon: "🗑️ ABANDON",
  };

  /**
   * Whether a `target` names the worktree this session already holds — branch, path or its origin.
   *
   * Paths are compared canonically: `/land /Users/me/repo.worktrees/x` and `x` are the same
   * worktree, and the card must not call the user's own tree a takeover.
   */
  async function namesSameWorktree(
    b: NonNullable<Awaited<ReturnType<typeof resolveBinding>>>,
    named: string,
  ): Promise<boolean> {
    if (named === b.branch || named === b.root || named === b.origin) return true;
    if (!named.startsWith("/")) return false;
    try {
      return (await canonicalPath(named)) === (await canonicalPath(b.root));
    } catch {
      return false;
    }
  }

  /**
   * What the user is being asked, gathered without doing any of it.
   *
   * The gate runs before the tool, so these numbers come from the same helpers the tool would use
   * and never from its result. `null` means there is nothing worth asking — no repository, or no
   * link to act on — and the tool's own error is the better answer.
   */
  async function askCard(
    exec: ExecFn,
    cwd: string,
    kind: GateKind,
    params: Record<string, unknown>,
    me: string | null | undefined,
  ): Promise<AskCard | null> {
    try {
      if (kind === "create") {
        const facts = await collectFacts(exec, cwd);
        if (!facts) return null;
        // One worktree per session: a session that already owns one cannot open a second, and the
        // tool says so with a hint pointing at the link it holds. A card offering to approve the
        // impossible would be asking the user to authorize an error message.
        if (await resolveBinding(exec, cwd, me)) return null;
        const dirty = porcelainPaths(facts.porcelain);
        const wanted = Array.isArray(params.carryPaths) ? params.carryPaths.map(String) : [];
        const carried = params.carry === false ? [] : wanted.length > 0 ? wanted : dirty;
        const changes = carried.length > 0 ? await workingChanges(exec, cwd, carried) : [];
        const branch = typeof params.branch === "string" && params.branch ? params.branch : "a new branch";
        const summary =
          params.carry === false
            ? dirty.length > 0
              ? `carrying nothing · ${count("file", dirty.length)} stays in origin`
              : "clean · nothing to carry"
            : dirty.length === 0
              ? "clean · nothing to carry"
              : wanted.length > 0
                ? `carrying ${carried.length} of ${dirty.length} files · ${dirty.length - carried.length} left in origin`
                : `carrying ${count("file", carried.length)}`;
        return {
          kind,
          hero: `${facts.branch ?? "?"} -> ${branch}`,
          summary,
          files: changes.map((c) => ({ status: c.status, path: c.path, added: c.added, deleted: c.deleted })),
        };
      }

      // Which worktree is this about? The bare call is this session's own link. A named one is that
      // name — and if the name is not the link this session holds, the tool is taking over somebody
      // else's worktree, which is a different question with a different card. (A card built from the
      // link it *does* hold would describe one worktree while the other one lands.)
      const b = await resolveBinding(exec, cwd, me);
      const named = typeof params.target === "string" && params.target.trim() ? params.target.trim() : "";
      const own = named === "" || (b !== null && (await namesSameWorktree(b, named)));
      if (!b || !own) {
        // Nothing of this session's own to describe: a bare call has no card and the tool's own
        // error is the better answer, while a takeover keeps one — the host cannot read that
        // worktree's numbers, but it can state the one fact that matters about it.
        if (!named) return null;
        return { kind, hero: named, summary: "not this session's worktree — taken over deliberately" };
      }

      if (kind === "abandon") {
        const wt = await collectFacts(exec, b.root);
        const ab = b.originBranch ? await aheadBehind(exec, b.root, b.originBranch, "HEAD") : { ahead: 0, behind: 0 };
        const dirty = wt ? wt.porcelain.split("\n").filter(Boolean).length : 0;
        const bits: string[] = [];
        if (ab.ahead) bits.push(count("commit", ab.ahead));
        if (dirty) bits.push(count("dirty file", dirty));
        // An empty worktree loses nothing: throwing it away is cleanup, and a card asking the user
        // to approve a deletion that deletes nothing is noise between them and the work.
        if (bits.length === 0) return null;
        return { kind, hero: b.branch, summary: `${bits.join(" · ")} will be discarded` };
      }

      // Land: what the merge would carry, read before it carries it.
      //
      // Uncommitted work is part of that, and so is the origin's: the land checkpoints both sides
      // before it merges. A card reading `nothing new · nothing to clean` beside a paragraph that
      // just described two changed files is a card asking the user to approve nothing.
      const base = b.originBranch ?? "origin";
      const ab = await aheadBehind(exec, b.root, base, "HEAD");
      const wt = await collectFacts(exec, b.root);
      const wtFiles = wt ? wt.porcelain.split("\n").filter(Boolean) : [];
      const pending = wtFiles.length;
      // A file the worktree added and never committed is invisible to a diff against the base — git
      // does not see untracked files that way — but the landing commits it, so the card must too.
      const untracked = wtFiles.filter((l) => l.startsWith("?? ")).map((l) => l.slice(3).trim());
      const origin = await collectFacts(exec, b.origin);
      const originPending = origin ? porcelainPaths(origin.porcelain).length : 0;
      // Nothing on either side: the landing is cleanup. The card would have to read `nothing new ·
      // nothing to clean` and ask the user to approve it, and that is not a question.
      if (ab.ahead === 0 && pending === 0 && originPending === 0) return null;
      const [changes, added, subjects, prefs] = await Promise.all([
        worktreeChanges(exec, b.root, base),
        untracked.length > 0 ? workingChanges(exec, b.root, untracked) : Promise.resolve([]),
        commitSubjects(exec, b.root, base, "HEAD"),
        loadPrefs(),
      ]);
      const strategy = validStrategy(prefs.defaultStrategy) ? prefs.defaultStrategy : DEFAULT_STRATEGY;
      // The land writes the pending work up as one checkpoint commit (task as its subject), so the
      // card counts it: it is a commit the user is approving, not a detail of the machinery.
      const checkpoint = pending > 0 ? 1 : 0;
      const carrying = ab.ahead + checkpoint;
      // The worktree has nothing of its own; the news is the origin's pending files, which the
      // landing checkpoints before it merges. A head reading `0 commits` would be a card about
      // nothing all over again, so this one carries the sentence instead of the count.
      if (carrying === 0) {
        return {
          kind,
          hero: `${b.branch} -> ${base}`,
          note: `will ${strategy}`,
          summary: `${count("file", originPending)} pending in ${base} — checkpointed first, then \`${b.branch}\` is cleaned up`,
        };
      }
      return {
        kind,
        hero: `${b.branch} -> ${base}`,
        note: `will ${strategy}`,
        commitCount: carrying,
        commits: [
          ...subjects,
          ...(checkpoint
            ? [`${count("file", pending)} uncommitted — written up as one checkpoint commit`]
            : []),
          ...(originPending
            ? [`${count("file", originPending)} pending in ${base} — checkpointed as \`wip(${base})\` first`]
            : []),
        ],
        files: [...changes, ...added].map((c) => ({ status: c.status, path: c.path, added: c.added, deleted: c.deleted })),
      };
    } catch {
      return null;
    }
  }

  /**
   * One card, painted for a terminal.
   *
   * Same rows the tool's own card uses, with the numbers read before anything happened. A card with
   * a commit count heads its file list with the count; one without heads it with the summary — which
   * is what the two cards looked like in the first place.
   */
  function paintAsk(c: AskCard, ink: CardInk, width: number): string {
    const hero = `${GATE_LABELS[c.kind]} ${ink.hero(`【${c.hero}】`)}`;
    const head = c.note ? `${hero} ${ink.dim(`· ${c.note}`)}` : hero;
    const files = (c.files ?? []) as FileChange[];
    const rows: DiagramRow[] = [];
    if (c.commitCount !== undefined) {
      rows.push({ head: treeHead(c.commitCount, "commit", ink), children: (c.commits ?? []).map((s) => wrapChild(ink.text(s), width)) });
    }
    if (files.length > 0) {
      rows.push({ head: c.commitCount !== undefined ? treeHead(files.length, "file", ink) : ink.dim(c.summary ?? ""), children: fileLines(files, undefined, ink, width) });
    } else if (rows.length === 0) {
      rows.push({ head: ink.dim(c.summary ?? "") });
    } else if (c.summary) {
      rows.push({ head: ink.dim(c.summary) });
    }
    return [head, ...diagramTree(rows, ink.dim)].join("\n");
  }


  const renderCard: Parameters<typeof pi.registerMessageRenderer>[1] = (message, opts, theme) => {
    const full = typeof message.content === "string" ? message.content : "";
    const d = message.details as CardDetails | undefined;
    const ink = makeInk(theme);
    const block = (build: string | ((width: number) => string)) =>
      cardBox(opts.outputPad, (t: string) => theme.bg("toolPendingBg", t), typeof build === "function" ? build : () => build);
    if (opts.expanded || !d) return block(full);
    if (d.kind === "create") return block((w) => worktreeText(d, ink, w));
    if (d.kind === "land") return block((w) => landText(d, ink, full, w));
    if (d.kind === "abandon") {
      if (!d.ok) return block(ink.error(`❌ ${firstLine(full)}`));
      return block((w) => abandonText(d, ink, w));
    }
    return block(ink.error(`❌ ${firstLine(full)}`));
  };

  // Both names, one renderer: a session opened from before the rename still draws its cards.
  pi.registerMessageRenderer(CARD_TYPE, renderCard);
  pi.registerMessageRenderer(LEGACY_CARD_TYPE, renderCard);

  // ------------------------------------------------------------- create flow

  interface CreateOpts {
    branch?: string;
    base?: string;
    path?: string;
    carry: boolean;
    /** Carry only these pathspecs; omit to carry all uncommitted changes. */
    carryPaths?: string[];
    /** Tool path (model): collisions auto-bump (-2, -3). Command path
     *  (human --branch): collisions stay a hard error (typo protection). */
    autoBump?: boolean;
    task: string;
    reason?: string | null;
    sessionId: string | null;
  }

  type CreateResult =
    | {
        ok: true; link: WorktreeLink; branch: string; path: string; carried: boolean; carryNote: string;
        from: string | null; carriedPaths: string[]; carriedChanges: FileChange[]; totalDirty: number; selective: boolean; clean: boolean;
        bumpedFrom: string | null;
      }
    | { ok: false; reason: string; text: string; link?: WorktreeLink };

  async function createFlow(exec: ExecFn, cwd: string, opts: CreateOpts): Promise<CreateResult> {
    const topLevel = await getTopLevel(exec, cwd);
    if (!topLevel) return { ok: false, reason: "not-a-repo", text: "Not a git repository." };
    const commonDir = await getCommonDir(exec, cwd);
    if (!commonDir) return { ok: false, reason: "no-common-dir", text: "Cannot resolve git dir." };
    const facts = await collectFacts(exec, cwd);
    if (!facts) return { ok: false, reason: "not-a-repo", text: "Not a git repository." };
    const canon = await canonicalPath(topLevel);

    // One session, one worktree per repo — point back at the owned link.
    const owned = ownActiveLink(await loadSyncedStore(exec, cwd, commonDir), canon, opts.sessionId);
    if (owned) {
      return {
        ok: false,
        reason: "already-own-active",
        link: owned,
        text: `This session already owns worktree \`${owned.branch}\` at ${owned.worktreePath}${owned.task ? ` (${truncateMiddle(owned.task, 40)})` : ""} — continue there. /land it first if the work is done.`,
      };
    }

    const explicit = sanitizeBranchName(opts.branch ?? "");
    let branch = explicit || await resolveUniqueBranch(exec, cwd, sanitizeBranchName(suggestBranchName(facts.branch, opts.task)));
    let bumpedFrom: string | null = null;
    if (!branch) return { ok: false, reason: "bad-branch", text: "Cannot determine a valid branch name." };
    if (explicit && await branchExists(exec, cwd, branch)) {
      if (!opts.autoBump) {
        return { ok: false, reason: "branch-exists", text: `Branch \`${branch}\` already exists. Pick another name.` };
      }
      bumpedFrom = branch;
      branch = await resolveUniqueBranch(exec, cwd, branch);
      if (!branch) return { ok: false, reason: "bad-branch", text: "Cannot determine a valid branch name." };
    }
    if (opts.base && !(await refExists(exec, cwd, opts.base))) {
      return { ok: false, reason: "bad-base", text: `Base ref \`${opts.base}\` does not exist.` };
    }

    const { resolve } = await import("node:path");
    const { mkdir } = await import("node:fs/promises");
    let targetPath: string;
    if (opts.path) {
      targetPath = opts.path.startsWith("/") ? opts.path : resolve(cwd, opts.path);
    } else {
      const { dir, path: dflt } = await defaultWorktreePath(topLevel, branch);
      await mkdir(dir, { recursive: true });
      targetPath = await dedupePath(dflt);
    }

    const created = await createWorktree(exec, cwd, { branch, path: targetPath, base: opts.base });
    if (!created.ok) return { ok: false, reason: "worktree-add-failed", text: `git worktree add failed:\n${created.output}` };

    let carried = false;
    let carryNote = "clean — nothing to carry";
    const selective = !!opts.carryPaths?.length;
    if (opts.carry && !facts.clean) {
      const res = await carryChangesViaStash(exec, cwd, targetPath, `pid-worktree:${branch}`, undefined, selective ? opts.carryPaths : undefined);
      carried = res.carried;
      const n = opts.carryPaths?.length ?? 0;
      carryNote = res.carried
        ? selective
          ? `carried ${n} selected file${n === 1 ? "" : "s"} via stash — unrelated changes left in origin`
          : "uncommitted changes carried via stash"
        : res.conflict
          ? `carry CONFLICT — stash kept (${res.stashRef ?? "refs/stash"}); resolve in ${targetPath}. ${res.output ?? ""}`
          : selective && res.reason === "clean"
            ? "selected files have no changes — nothing carried (other dirty files left in origin)"
            : `carry skipped: ${res.reason ?? res.output ?? "unknown"}`;
    } else if (!opts.carry) {
      carryNote = "carry disabled — new worktree starts from base only";
    }

    const link: WorktreeLink = {
      id: makeId(),
      originPath: canon,
      originBranch: facts.branch,
      originHead: facts.head,
      worktreePath: await canonicalPath(targetPath),
      branch,
      base: opts.base ?? facts.head,
      carried,
      createdAt: Date.now(),
      status: "active",
      sessionId: opts.sessionId,
      sessionName: pi.getSessionName() ?? null,
      task: opts.task || opts.reason || null,
    };
    await saveLink(commonDir, link);
    pi.appendEntry(LINK_ENTRY, link);
    await recordEvent({ kind: "create", ...link });
    const dirtyBefore = porcelainPaths(facts.porcelain);
    const carriedPaths = selective ? (opts.carryPaths ?? []) : carried ? dirtyBefore : [];
    // Status letters and line counts for the card come from the changes as they
    // now sit in the new worktree — the same bytes the carry moved over.
    const carriedChanges = carried && carriedPaths.length > 0
      ? await workingChanges(exec, targetPath, carriedPaths)
      : [];
    return {
      ok: true, link, branch, path: targetPath, carried, carryNote,
      from: facts.branch,
      carriedPaths: carriedChanges.length > 0 ? carriedChanges.map((c) => c.path) : carriedPaths,
      carriedChanges,
      totalDirty: dirtyBefore.length, selective, clean: facts.clean, bumpedFrom,
    };
  }

  /** Bind the session to a fresh link: name, title, chrome, policy cache. */
  async function bindSession(ctx: ExtensionContext, link: WorktreeLink): Promise<void> {
    try {
      pi.setSessionName(`🌲 ${link.branch}${link.task ? ` · ${truncateMiddle(link.task, 40)}` : ""}`);
    } catch {
      // Non-fatal.
    }
    const exec = getExec(ctx.cwd, ctx.signal ?? undefined);
    await resolveBinding(exec, ctx.cwd, ctx.sessionManager.getSessionId());
    await refreshChrome(ctx, ctx.cwd);
  }

  /** Undo bindSession after land/abandon: restore the pre-worktree name. */
  async function unbindSession(ctx: ExtensionContext, link: WorktreeLink | undefined): Promise<void> {
    if (link && binding && binding.linkId === link.id) {
      try {
        pi.setSessionName(link.sessionName || `✓ ${link.branch}`);
      } catch {
        // Non-fatal.
      }
      try {
        const { basename } = await import("node:path");
        ctx.ui.setTitle(basename(link.originPath));
      } catch {
        // Optional.
      }
    }
    const exec = getExec(ctx.cwd, ctx.signal ?? undefined);
    await resolveBinding(exec, ctx.cwd, ctx.sessionManager.getSessionId());
    await refreshChrome(ctx, ctx.cwd);
  }

  // --------------------------------------------------------------- land flow

  interface LandPreview {
    sourceBranch: string;
    targetBranch: string | null;
    ahead: number;
    behind: number;
    dirtySource: number;
    dirtyTarget: number;
    stat: DiffStat;
    subjects: string[];
    message: string;
  }

  interface LandFlowOpts {
    to?: string;
    strategy: Strategy;
    message?: string;
    remove: boolean;
    finish: boolean;
    abort: boolean;
    /** Current pi session id — recorded on links for visibility; ownership is advisory, never blocking. */
    sessionId?: string | null;
    /** Optional cancel hook for foreign-owned links. Omit it and the land proceeds with a foreign:true flag for the model to report. */
    confirmForeign?: (links: WorktreeLink[]) => Promise<boolean>;
    /** Slash-side picker when several children hang off this origin. */
    pickChild?: (kids: WorktreeLink[]) => Promise<WorktreeLink | undefined>;
    /** Slash-side preview: return the strategy to use, or undefined to cancel. */
    review?: (p: LandPreview) => Promise<{ strategy: Strategy; message: string } | undefined>;
  }

  interface LandResult {
    text: string;
    details: Record<string, unknown>;
    link?: WorktreeLink;
  }

  async function landFlow(exec: ExecFn, cwd: string, opts: LandFlowOpts): Promise<LandResult> {
    const topLevel = await getTopLevel(exec, cwd);
    if (!topLevel) return { text: "Not a git repository.", details: { ok: false, reason: "not-a-repo" } };
    const commonDir = await getCommonDir(exec, cwd);
    if (!commonDir) return { text: "Cannot resolve git dir.", details: { ok: false, reason: "no-common-dir" } };
    const canon = await canonicalPath(topLevel);
    const store = await loadSyncedStore(exec, cwd, commonDir);

    // Resolve source (where the feature commits live) and target (origin).
    // Standing in a child: source = here, target = origin. Standing at the
    // origin: source = the bound/only child, target = here. Both DWIM so the
    // user never has to think about direction.
    let link = activeLinkFor(store, canon) ?? findByWorktree(store, canon);
    let sourcePath = canon;
    let sourceBranch = (await collectFacts(exec, cwd))?.branch ?? link?.branch ?? null;
    let targetPath: string | undefined;
    let targetBranch: string | undefined;

    const flipTo = async (child: WorktreeLink) => {
      link = child;
      sourcePath = await canonicalPath(child.worktreePath);
      sourceBranch = child.branch;
      targetPath = canon;
      targetBranch = (await collectFacts(exec, cwd))?.branch ?? child.originBranch ?? undefined;
    };

    if (link && link.status === "active") {
      targetPath = link.originPath;
      targetBranch = link.originBranch ?? undefined;
    } else if (!opts.to) {
      // One session, one tree: a bare land means "land MY tree". Resolve only
      // the owning session's link (or a single unowned link nobody would miss).
      // Other sessions' worktrees are listed for visibility and left untouched —
      // taking one over requires naming it explicitly (deliberate intent).
      const kids = childrenOf(store, canon);
      const mine = opts.sessionId ? kids.find((k) => k.sessionId === opts.sessionId) : undefined;
      if (mine) {
        await flipTo(mine);
      } else if (kids.length === 1 && !foreignOwnerOf(kids[0], opts.sessionId, canon)) {
        await flipTo(kids[0]);
      } else if (kids.length > 0) {
        const picked = opts.pickChild ? await opts.pickChild(kids) : undefined;
        if (picked) {
          await flipTo(picked);
        } else if (opts.pickChild) {
          return { text: "Cancelled.", details: { ok: false, reason: "cancelled" } };
        } else {
          const others = kids.map((k) => `\`${k.branch}\` ${ownerLabel(k, opts.sessionId)}${k.task ? ` — ${truncateMiddle(k.task, 40)}` : ""}`).join("\n");
          return {
            text: [
              `This session has no linked worktree to land — leaving other sessions' work alone:`,
              others,
              `To land one of these, run /land from its owning session, stand inside that worktree, or name it explicitly to take it over deliberately.`,
            ].join("\n"),
            details: { ok: false, reason: "no-own-link", children: kids },
          };
        }
      }
    }
    if (opts.to) {
      const { existsSync } = await import("node:fs");
      if (opts.to.startsWith("/") && existsSync(opts.to)) {
        targetPath = await canonicalPath(opts.to);
      } else {
        const wts = await listWorktrees(exec, cwd);
        const hit = wts.find((w) => w.branch === opts.to);
        if (hit) {
          targetPath = await canonicalPath(hit.path);
          targetBranch = hit.branch ?? undefined;
        } else {
          targetPath = opts.to;
        }
      }
      // DWIM: naming a linked child of the current location means "land that
      // child here" — never "merge here into the child".
      if (targetPath && !activeLinkFor(store, canon)) {
        const named = findByWorktree(store, targetPath);
        if (named && named.status === "active" && samePath(named.originPath, canon) && !samePath(targetPath, canon)) {
          await flipTo(named);
        }
      }
    }
    if (!targetPath) {
      const wts = await listWorktrees(exec, cwd);
      const others = wts.filter((w) => w.path !== canon && !w.bare);
      if (others.length === 1) {
        targetPath = await canonicalPath(others[0].path);
        targetBranch = others[0].branch ?? undefined;
        const hereBranch = (await collectFacts(exec, cwd))?.branch;
        const hereIsMain = hereBranch === "main" || hereBranch === "master";
        const otherIsMain = targetBranch === "main" || targetBranch === "master";
        if (hereIsMain && !otherIsMain) {
          sourcePath = targetPath;
          sourceBranch = targetBranch ?? null;
          targetPath = canon;
          targetBranch = hereBranch ?? undefined;
        }
      } else {
        const names = others.map((w) => `${w.branch ?? "?"} @ ${w.path}`).join("\n") || "(none)";
        return {
          text: `Cannot determine land target. Pass target explicitly.\nOther worktrees:\n${names}`,
          details: { ok: false, reason: "ambiguous-target", others },
        };
      }
    }
    targetPath = await canonicalPath(targetPath);

    if (targetPath === sourcePath) {
      return { text: "Source and target are the same worktree — nothing to land.", details: { ok: false, reason: "same-path" } };
    }
    if (!sourceBranch) {
      return {
        text: "Source HEAD is detached — create a branch first (`git switch -c <name>`) so /land knows what to merge.",
        details: { ok: false, reason: "detached-source" },
      };
    }
    // Validate before diagnosing: a path that does not exist (or is not a
    // repo) makes every git probe fail, and those failures are not a HEAD
    // state. Without this, `git symbolic-ref` exit 128 reads as "detached".
    if (!(await isWorkTree(exec, targetPath))) {
      return {
        text: `Target ${targetPath} is not a git work tree — no such directory, or not a repository. Check the path (a branch name or a bare /land avoids naming a path at all).`,
        details: { ok: false, reason: "bad-target", target: targetPath },
      };
    }
    if (await isDetached(exec, targetPath)) {
      return {
        text: `Target ${targetPath} is on a detached HEAD — landing there would leave the result on an anonymous commit. Check out a branch in the target first.`,
        details: { ok: false, reason: "detached-target", target: targetPath },
      };
    }
    if (!targetBranch) targetBranch = (await collectFacts(exec, targetPath))?.branch ?? undefined;

    // Ownership scopes implicit resolution (above), never explicit intent: naming
    // a branch/path or standing inside its worktree is deliberate, so it proceeds
    // with a foreign flag for the model to report. Edge cases are the model's job.
    // confirmForeign (slash) may still cancel.
    let foreign: WorktreeLink[] = [];
    let foreignNote: string | null = null;
    {
      const candidates = [link, findByWorktree(store, targetPath)];
      foreign = [...new Set(candidates.filter((l): l is WorktreeLink => !!l))]
        .map((l) => foreignOwnerOf(l, opts.sessionId, canon))
        .filter((l): l is WorktreeLink => !!l);
      if (foreign.length > 0) {
        const who = foreign.map((l) => `\`${l.branch}\` ${ownerLabel(l, opts.sessionId)}`).join(", ");
        if (opts.confirmForeign && !(await opts.confirmForeign(foreign))) {
          return { text: "Cancelled — left the other session's worktree alone.", details: { ok: false, reason: "cancelled" } };
        }
        foreignNote = `Note: ${who} was owned by another session — proceeded anyway. Say who owned it and what you did in your own words.`;
      }
    }

    // Abort / finish operate on whichever side holds MERGE_HEAD.
    const mergeDir = (await hasMergeHead(exec, targetPath))
      ? targetPath
      : (await hasMergeHead(exec, sourcePath)) ? sourcePath : null;
    if (opts.abort) {
      if (!mergeDir) return { text: "No merge in progress here — nothing to abort.", details: { ok: false, reason: "no-merge" } };
      const r = await abortMerge(exec, mergeDir);
      const out = `${r.stdout}\n${r.stderr}`.trim();
      await recordEvent({ kind: "land-abort", dir: mergeDir });
      return { text: r.code === 0 ? `Merge aborted in ${mergeDir}.\n${out}` : `Abort failed in ${mergeDir}.\n${out}`, details: { ok: r.code === 0, dir: mergeDir } };
    }
    if (opts.finish || mergeDir) {
      if (!mergeDir) return { text: "No merge in progress — nothing to finish.", details: { ok: false, reason: "no-merge" } };
      const unmerged = await unmergedFiles(exec, mergeDir);
      if (unmerged.length > 0) {
        return {
          text: `Merge in progress in ${mergeDir} with conflicts:\n${unmerged.map((f) => `  ${f}`).join("\n")}\nResolve files, \`git add\` them, then finish the land (worktree_land finish:true). To abandon it, abort (worktree_land abort:true).`,
          details: { ok: false, reason: "conflict", conflicted: unmerged, target: mergeDir, branch: sourceBranch, dest: targetBranch },
        };
      }
      const commit = await exec("git", ["commit", "--no-edit"], { cwd: mergeDir });
      const out = `${commit.stdout}\n${commit.stderr}`.trim().slice(0, 2000);
      if (commit.code !== 0) return { text: `Could not conclude merge:\n${out}`, details: { ok: false, reason: "finish-failed", output: out } };
      const sha = await headOf(exec, mergeDir);
      const effLink = link ?? store.links.find((l) => l.status === "active" && samePath(l.originPath, mergeDir));
      if (effLink) await saveLink(commonDir, { ...effLink, status: "landed", landedAt: Date.now(), landStrategy: "merge", landSha: sha });
      await recordEvent({ kind: "land-finish", source: effLink?.worktreePath ?? sourcePath, target: mergeDir, sha });
      const cleanup = opts.remove && effLink
        ? await cleanupWorktree(exec, commonDir, effLink, effLink.worktreePath, effLink.branch, mergeDir)
        : opts.remove ? "Linkage not found — worktree left in place; remove manually with `git worktree remove <path>`." : "";
      return {
        text: `Merge concluded in ${mergeDir} (${shortSha(sha)}).\n${out}${cleanup ? `\n${cleanup}` : ""}`,
        details: { ok: true, finished: true, sha, target: mergeDir, cleanup, strategy: "merge", branch: effLink?.branch ?? sourceBranch, dest: effLink?.originBranch ?? targetBranch },
        link: effLink,
      };
    }

    // Preview: what lands, and with which message.
    const srcStatus = await getStatusPorcelain(exec, sourcePath);
    const tgtStatus = await getStatusPorcelain(exec, targetPath);
    const ab = targetBranch ? await aheadBehind(exec, sourcePath, targetBranch, "HEAD") : { ahead: 0, behind: 0 };
    const stat = targetBranch ? await diffStat(exec, sourcePath, targetBranch, "HEAD") : { files: 0, insertions: 0, deletions: 0 };
    const subjects = targetBranch ? await commitSubjects(exec, sourcePath, targetBranch, "HEAD") : [];
    const defaultMsg = opts.message?.trim() || subjectFromTask(link?.task, `${sourceBranch}: land into ${targetBranch ?? "origin"}`);
    const preview: LandPreview = {
      sourceBranch,
      targetBranch: targetBranch ?? null,
      ahead: ab.ahead,
      behind: ab.behind,
      dirtySource: srcStatus.porcelain.split("\n").filter(Boolean).length,
      dirtyTarget: tgtStatus.porcelain.split("\n").filter(Boolean).length,
      stat,
      subjects,
      message: defaultMsg,
    };
    if (preview.ahead === 0 && preview.dirtySource === 0) {
      // Empty worktree: nothing would be lost by removing it, so just do it.
      // This is the "替用户做了" path — /land on an empty worktree cleans up
      // instead of erroring with "use worktree_abandon to drop".
      if (link && opts.remove && !samePath(canon, sourcePath)) {
        const cleanup = await cleanupWorktree(exec, commonDir, link, sourcePath, sourceBranch, targetPath);
        await recordEvent({ kind: "land-empty-cleanup", source: sourcePath, target: targetPath, branch: sourceBranch });
        const kept = cleanup && !cleanup.startsWith("Cleaned up") ? cleanup.split("\n")[0] : null;
        if (!kept) {
          return {
            text: [`Nothing to land: \`${sourceBranch}\` was empty — cleaned up.`, foreignNote ?? ""].filter(Boolean).join("\n"),
            details: { ok: true, empty: true, cleaned: true, branch: sourceBranch, dest: targetBranch, strategy: opts.strategy, sha: null, cleanup, foreign: foreign.map((l) => l.branch) },
            link,
          };
        }
        // Cleanup refused (e.g. protected branch): surface the reason, no second step.
        return {
          text: `Nothing to land: \`${sourceBranch}\` is empty. ${kept}`,
          details: { ok: true, empty: true, cleaned: false, branch: sourceBranch, dest: targetBranch, strategy: opts.strategy, sha: null, kept },
          link,
        };
      }
      if (link && samePath(canon, sourcePath)) {
        return {
          text: `Nothing to land: \`${sourceBranch}\` is empty. You are standing inside it — go back to \`${targetBranch ?? "origin"}\` (${targetPath}) and run /land again to clean it up.`,
          details: { ok: false, reason: "standing-inside-empty", branch: sourceBranch, dest: targetBranch },
        };
      }
      if (link && !opts.remove) {
        return {
          text: `Nothing to land: \`${sourceBranch}\` is empty — kept (remove:false).`,
          details: { ok: true, empty: true, cleaned: false, branch: sourceBranch, dest: targetBranch, strategy: opts.strategy, sha: null },
          link,
        };
      }
      return {
        text: `Nothing to land: \`${sourceBranch}\` has no commits or changes beyond \`${targetBranch ?? "origin"}\`.`,
        details: { ok: false, reason: "nothing-to-land", branch: sourceBranch, dest: targetBranch },
      };
    }
    let strategy = opts.strategy;
    let message = defaultMsg;
    if (opts.review) {
      const choice = await opts.review(preview);
      if (!choice) return { text: "Cancelled.", details: { ok: false, reason: "cancelled" } };
      strategy = choice.strategy;
      message = choice.message || defaultMsg;
    }

    // Checkpoint both sides. The source checkpoint carries the task as its
    // subject so the landed history reads like intent, not timestamps.
    // Both are recorded: auto-created commits deserve visibility.
    const checkpoints: CheckpointInfo[] = [];
    if (!srcStatus.clean) {
      const c = await ensureCommitted(exec, sourcePath, message);
      if (!c.committed) {
        return {
          text: `Could not commit pending changes in ${sourcePath}:\n${c.output}\nConfigure git identity or commit manually, then retry.`,
          details: { ok: false, reason: "commit-failed", output: c.output },
        };
      }
      checkpoints.push({ branch: sourceBranch, side: "source", paths: porcelainPaths(srcStatus.porcelain), subject: message });
    }
    let targetCheckpoint: string | null = null;
    if (!tgtStatus.clean) {
      const subject = `wip(${targetBranch ?? "origin"}): checkpoint before landing ${sourceBranch}`;
      const c = await ensureCommitted(exec, targetPath, subject);
      if (!c.committed) {
        return {
          text: `Could not commit pending changes in target ${targetPath}:\n${c.output}\nConfigure git identity or commit manually, then retry.`,
          details: { ok: false, reason: "target-commit-failed", output: c.output, target: targetPath },
        };
      }
      targetCheckpoint = c.sha ?? null;
      checkpoints.push({ branch: targetBranch ?? "origin", side: "target", paths: porcelainPaths(tgtStatus.porcelain), subject });
    }

    // Post-checkpoint truth: what actually lands (subjects/changes/counts).
    const landed = targetBranch
      ? {
        ahead: (await aheadBehind(exec, sourcePath, targetBranch, "HEAD")).ahead,
        stat: await diffStat(exec, sourcePath, targetBranch, "HEAD"),
        subjects: await commitSubjects(exec, sourcePath, targetBranch, "HEAD"),
        changes: await diffChanges(exec, sourcePath, targetBranch, "HEAD"),
      }
      : { ahead: 0, stat: { files: 0, insertions: 0, deletions: 0 }, subjects: [] as string[], changes: [] as FileChange[] };

    const merged = await mergeInto(exec, targetPath, sourceBranch, strategy, message, undefined, sourcePath, targetBranch ?? null);
    if (!merged.ok) {
      if (merged.reason === "conflict") {
        await recordEvent({ kind: "land-conflict", source: sourcePath, target: targetPath, conflicted: merged.conflicted });
        return {
          text: [
            `Merge conflict landing \`${sourceBranch}\` into ${targetPath}${merged.note ? ` (${merged.note})` : ""}.`,
            `Conflicted files:\n${merged.conflicted.map((f) => `  ${f}`).join("\n")}`,
            `Handle it yourself: read each conflicted file, keep the intended result from both sides (task changes win on task files, origin changes win elsewhere), \`git add\` them, then finish the land (worktree_land finish:true). To throw the work away instead, abort (worktree_land abort:true). Only ask the user when both sides look deliberately contradictory and you cannot tell which is intended.`,
            foreignNote ?? "",
          ].filter(Boolean).join("\n"),
          details: { ok: false, reason: "conflict", conflicted: merged.conflicted, target: targetPath, source: sourcePath, output: merged.output, branch: sourceBranch, dest: targetBranch, foreign: foreign.map((l) => l.branch) },
          link: link ?? undefined,
        };
      }
      return {
        text: merged.reason === "nothing-to-land"
          ? `Nothing to land: \`${sourceBranch}\` introduces no changes on top of \`${targetBranch ?? "origin"}\`.`
          : `Landing \`${sourceBranch}\` failed (${merged.applied}):\n${merged.output}`,
        details: { ok: false, reason: merged.reason ?? "failed", output: merged.output, branch: sourceBranch, dest: targetBranch },
      };
    }

    const sha = await headOf(exec, targetPath);
    if (link) await saveLink(commonDir, { ...link, status: "landed", landedAt: Date.now(), landStrategy: merged.applied, landSha: sha });
    await recordEvent({ kind: "land", source: sourcePath, target: targetPath, strategy: merged.applied, sha });
    const cleanup = opts.remove ? await cleanupWorktree(exec, commonDir, link, sourcePath, sourceBranch, targetPath) : "";
    const label = merged.applied === "rebase" ? "rebase" : merged.applied;
    const kept = cleanup && !cleanup.startsWith("Cleaned up") ? cleanup.split("\n")[0] : null;
    return {
      text: [
        `Landed \`${sourceBranch}\` into ${targetPath} (${label}, ${shortSha(sha)}).`,
        merged.note ?? "",
        targetCheckpoint ? `Target had pending changes — checkpointed as ${shortSha(targetCheckpoint)} before landing.` : "",
        merged.output,
        cleanup,
        foreignNote ?? "",
      ].filter(Boolean).join("\n"),
      details: {
        ok: true, sha, target: targetPath, source: sourcePath, strategy: label,
        note: merged.note, cleanup, targetCheckpoint, branch: sourceBranch, dest: targetBranch,
        ahead: landed.ahead, stat: landed.stat, changes: landed.changes, names: landed.changes.map((c) => c.path), subjects: landed.subjects,
        checkpoints, kept, foreign: foreign.map((l) => l.branch),
      },
      link: link ?? undefined,
    };
  }

  async function headOf(exec: ExecFn, cwd: string): Promise<string | null> {
    const r = await exec("git", ["rev-parse", "HEAD"], { cwd });
    return r.code === 0 ? r.stdout.trim() : null;
  }

  async function cleanupWorktree(
    exec: ExecFn,
    commonDir: string,
    link: WorktreeLink | undefined,
    sourcePath: string,
    sourceBranch: string,
    targetPath: string,
  ): Promise<string> {
    // main/master are never auto-deleted, and a main working tree is never
    // removed — a reverse-land must degrade to words, not dangerous commands.
    if (sourceBranch === "main" || sourceBranch === "master") {
      return `Kept branch \`${sourceBranch}\` — never auto-delete it. Worktree left in place.`;
    }
    const removal = await removeWorktree(exec, targetPath, sourcePath);
    if (removal.code !== 0) {
      const err = `${removal.stdout}\n${removal.stderr}`.trim().slice(0, 800);
      if (/main working tree|not a working tree/i.test(err)) {
        return `Cleanup skipped — ${sourcePath} is not a removable worktree. Branch \`${sourceBranch}\` kept.`;
      }
      return `Cleanup skipped (run manually): \`git -C ${targetPath} worktree remove ${sourcePath}\` — ${err}\nThen \`git branch -d ${sourceBranch}\` if merged.`;
    }
    const del = await deleteBranch(exec, targetPath, sourceBranch);
    const branchNote = del.code === 0
      ? `Branch \`${sourceBranch}\` deleted.`
      : `Worktree removed; branch kept (\`git branch -d ${sourceBranch}\` when ready).`;
    if (link) {
      try {
        const fresh = (await loadStore(commonDir)).links.find((l) => l.id === link.id) ?? link;
        await saveLink(commonDir, { ...fresh, status: "removed", landedAt: fresh.landedAt ?? Date.now() });
      } catch {
        // Store is advisory; git is truth.
      }
    }
    await pruneWorktrees(exec, targetPath);
    return `Cleaned up: worktree removed. ${branchNote}`;
  }

  // ------------------------------------------------------------ abandon flow

  interface AbandonOpts {
    target?: string;
    confirm: boolean;
    sessionId: string | null;
  }

  async function abandonFlow(exec: ExecFn, cwd: string, opts: AbandonOpts): Promise<LandResult> {
    const topLevel = await getTopLevel(exec, cwd);
    if (!topLevel) return { text: "Not a git repository.", details: { ok: false, reason: "not-a-repo" } };
    const commonDir = await getCommonDir(exec, cwd);
    if (!commonDir) return { text: "Cannot resolve git dir.", details: { ok: false, reason: "no-common-dir" } };
    const canon = await canonicalPath(topLevel);
    const store = await loadSyncedStore(exec, cwd, commonDir);

    let link = activeLinkFor(store, canon) ?? ownActiveLink(store, canon, opts.sessionId);
    if (opts.target) {
      const byBranch = store.links.find((l) => l.status === "active" && l.branch === opts.target);
      link = byBranch ?? (await (async () => {
        const p = await canonicalPath(opts.target!);
        return activeLinkFor(store, p);
      })());
    }
    if (!link) {
      return { text: "No active linked worktree to abandon here. Name its branch or path.", details: { ok: false, reason: "no-link" } };
    }
    // Ownership is advisory, never a hard stop — same rule as land. The model
    // names the previous owner in chat; empty worktrees drop immediately,
    // non-empty ones still need confirm:true (model confirms with the user
    // in chat first, then calls again).
    const foreignLink = foreignOwnerOf(link, opts.sessionId, canon);
    const foreignSuffix = foreignLink ? ` (was owned by another session ${ownerLabel(link, opts.sessionId)} — proceeding anyway; say so in chat)` : "";
    if (link.branch === "main" || link.branch === "master") {
      return { text: `Refusing to abandon \`${link.branch}\`.`, details: { ok: false, reason: "protected-branch" } };
    }
    if (samePath(canon, link.worktreePath)) {
      return {
        text: `You are standing inside ${link.worktreePath}. Abandon it from the origin (${link.originPath}) so the directory can be removed.`,
        details: { ok: false, reason: "standing-inside", origin: link.originPath },
      };
    }

    const ab = link.originBranch ? await aheadBehind(exec, link.worktreePath, link.originBranch, "HEAD") : { ahead: 0, behind: 0 };
    const dirty = (await getStatusPorcelain(exec, link.worktreePath)).porcelain.split("\n").filter(Boolean).length;
    const summary = `\`${link.branch}\`${link.task ? ` (${truncateMiddle(link.task, 40)})` : ""}: ${ab.ahead} unlanded commit${ab.ahead === 1 ? "" : "s"}, ${dirty} dirty file${dirty === 1 ? "" : "s"}.`;
    // Empty worktree: nothing to lose, so drop it immediately — no confirm dance.
    // This keeps `worktree_abandon` one-shot for the exact case /land auto-cleans.
    if (!opts.confirm && (ab.ahead > 0 || dirty > 0)) {
      return {
        text: `Would discard ${summary}${foreignSuffix}\nThis deletes the worktree directory and the branch permanently. Confirm with the user, then call again with confirm:true.`,
        details: { ok: false, reason: "needs-confirm", branch: link.branch, commits: ab.ahead, dirty, foreign: foreignLink ? link.branch : undefined },
      };
    }

    const removal = await removeWorktree(exec, link.originPath, link.worktreePath, true);
    if (removal.code !== 0) {
      const err = `${removal.stdout}\n${removal.stderr}`.trim().slice(0, 800);
      return { text: `Could not remove ${link.worktreePath}:\n${err}`, details: { ok: false, reason: "remove-failed", branch: link.branch, output: err } };
    }
    const del = await deleteBranch(exec, link.originPath, link.branch, true);
    await pruneWorktrees(exec, link.originPath);
    await saveLink(commonDir, { ...link, status: "removed", landedAt: Date.now(), abandoned: true });
    await recordEvent({ kind: "abandon", branch: link.branch, path: link.worktreePath, commits: ab.ahead, dirty });
    const branchNote = del.code === 0 ? `branch \`${link.branch}\` deleted` : `branch \`${link.branch}\` kept (delete failed)`;
    return {
      text: `Abandoned ${summary}${foreignSuffix} Worktree removed, ${branchNote}.`,
      details: { ok: true, branch: link.branch, commits: ab.ahead, dirty, foreign: foreignLink ? link.branch : undefined },
      link,
    };
  }

  // ------------------------------------------------------------------- tools

  pi.registerTool({
    name: "worktree_status",
    label: "Worktree Status",
    description:
      "Show git worktree state: current branch, clean/dirty files, all worktrees, pid-worktree origin/child linkage, and which worktree this session is bound to. Call this before risky edits to decide whether to isolate.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const exec = getExec(cwd, signal ?? undefined);
      const facts = await collectFacts(exec, cwd);
      if (!facts) return { content: [{ type: "text", text: "Not a git repository." }], details: { ok: false, reason: "not-a-repo" } };
      const canon = await canonicalPath(facts.topLevel);
      const store = facts.commonDir ? await loadSyncedStore(exec, cwd, facts.commonDir) : null;
      const link = store ? (activeLinkFor(store, canon) ?? findByWorktree(store, canon)) : undefined;
      const kids = store ? childrenOf(store, canon) : [];
      const me = ctx.sessionManager.getSessionId();
      const dirty = facts.porcelain.split("\n").filter(Boolean).length;
      const text = formatWorktreeList(facts.topLevel, facts.branch, facts.clean, facts.porcelain, facts.worktrees, link, kids, me, binding);
      return {
        content: [{ type: "text", text }],
        details: { ok: true, topLevel: facts.topLevel, branch: facts.branch, clean: facts.clean, dirty, worktrees: facts.worktrees, link: link ?? null, children: kids, bound: binding },
      };
    },
    renderShell: "self",
    renderCall: silentRender,
    renderResult: silentRender,
  });

  pi.registerTool({
    name: "worktree_create",
    label: "Worktree Create",
    description:
      "Create a new git worktree on a new branch, carry uncommitted changes via stash, and bind this session to it (subsequent tool calls run inside it). Use to isolate experimental, risky, or parallel work — never raw git worktree commands.",
    promptSnippet: "Isolate experimental work with worktree_create",
    promptGuidelines: [
      "Use worktree_create to isolate experimental, risky, or parallel work — never raw git worktree commands.",
      "Always pass an explicit `branch`: name it after the work, never a fixed or date-based format.",
      "When the workspace is dirty, triage first (worktree_status): carry only files related to the task via `carryPaths`; leave unrelated files untouched in the origin.",
      "Before you call it, say in one or two lines what you are isolating, on which branch, and what stays in the origin. The approval card carries the numbers; the words are yours to write.",
      "When work in the new worktree is finished, call worktree_land to finish — the host asks the user to approve first, so never land silently and never ask in prose (empty worktrees are the exception — just land to clean up).",
    ],
    parameters: Type.Object({
      task: Type.Optional(Type.String({ description: "One line describing the work. Becomes the land commit subject." })),
      branch: Type.Optional(Type.String({ description: "Branch name — always choose a descriptive one yourself; never a fixed or date-based format. Collisions auto-bump (-2, -3), no need to pre-check." })),
      base: Type.Optional(Type.String({ description: "Base ref for the new branch. Defaults to current HEAD." })),
      path: Type.Optional(Type.String({ description: "Worktree path. Defaults to a sibling .worktrees directory." })),
      carry: Type.Optional(Type.Boolean({ description: "Carry uncommitted changes via stash. Default true; pass false to start clean." })),
      carryPaths: Type.Optional(Type.Array(Type.String(), { description: "Carry only these paths (relative to the repo root); omit to carry all uncommitted changes. Use after triaging dirty files." })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const exec = getExec(cwd, signal ?? undefined);
      const r = await createFlow(exec, cwd, {
        branch: params.branch,
        base: params.base,
        path: params.path,
        carry: params.carry !== false,
        carryPaths: params.carryPaths,
        autoBump: true,
        task: (params.task ?? "").trim(),
        sessionId: ctx.sessionManager.getSessionId(),
      });
      if (!r.ok) {
        return { content: [{ type: "text", text: r.text }], details: { ok: false, reason: r.reason, branch: r.link?.branch, path: r.link?.worktreePath } };
      }
      await bindSession(ctx, r.link);
      const text = [
        `Worktree ready: \`${r.branch}\` at ${r.path} — ${r.carryNote}.`,
        r.bumpedFrom ? `Branch \`${r.bumpedFrom}\` already existed; using \`${r.branch}\`.` : "",
        `This session is now bound to it: relative paths and bash run inside the worktree automatically; edits under the origin checkout are blocked.`,
        `Finish with worktree_land after the user confirms, or worktree_abandon to discard.`,
      ].filter(Boolean).join("\n");
      return {
        content: [{ type: "text", text }],
        details: {
          ok: true, from: r.from, branch: r.branch, carried: r.carriedPaths,
          changes: r.carriedChanges,
          total: r.totalDirty, selective: r.selective, clean: r.clean,
        },
      };
    },
    renderShell: "self",
    renderCall: silentRender,
    renderResult(result, { expanded, isPartial }, theme) {
      const ink = makeInk(theme);
      const box = (build: string | ((width: number) => string)) =>
        cardBox(1, (t: string) => theme.bg("toolPendingBg", t), typeof build === "function" ? build : () => build);
      if (isPartial) return box(ink.dim("…"));
      const full = (result as { content?: Array<{ text?: unknown }> }).content?.map((b) => (typeof b?.text === "string" ? b.text : "")).filter(Boolean).join("\n") ?? "";
      if (expanded) return box(full);
      const d = (result as { details?: { ok?: unknown; from?: unknown; branch?: unknown; carried?: unknown; total?: unknown; selective?: unknown; clean?: unknown; changes?: unknown } }).details ?? {};
      if (d.ok !== true) return box(ink.error(`❌ ${firstLine(full)}`));
      return box((w) => worktreeText({
        from: typeof d.from === "string" ? d.from : "?",
        branch: typeof d.branch === "string" ? d.branch : "?",
        carried: Array.isArray(d.carried) ? d.carried.map(String) : [],
        total: typeof d.total === "number" ? d.total : 0,
        selective: d.selective === true,
        clean: d.clean === true,
        changes: Array.isArray(d.changes) ? d.changes as FileChange[] : undefined,
      }, ink, w));
    },
  });

  pi.registerTool({
    name: "worktree_land",
    label: "Worktree Land",
    description:
      "Land the linked worktree back into its origin: commits pending changes on both sides (subject = the task), rebases onto the origin and fast-forwards (falls back to a merge on conflict), surfaces conflicted files, and cleans up on success.",
    promptSnippet: "Land a linked worktree back into its origin",
    promptGuidelines: [
      "Use worktree_land to finish work inside a linked worktree instead of raw git merge commands.",
      "Before you call it, write the paragraph the user is about to approve: what changed, what you verified, and the conclusion. One short paragraph in plain words — the card shows the numbers, and no card can say what you decided or what you are unsure about.",
      "On conflict, resolve it yourself: read each conflicted file, keep the intended result from both sides, `git add`, then finish with finish:true. Explain the resolution in your own words; ask the user only when both sides look deliberately contradictory.",
      "Empty worktrees (no commits, clean) land as immediate cleanup with no confirmation needed — just call worktree_land.",
      "A bare land means YOUR tree: the tool resolves this session's own link (or the worktree you're standing in) and never auto-grabs another session's link. Name a branch/path explicitly only to deliberately take it over — then say who owned it and what you did.",
    ],
    parameters: Type.Object({
      target: Type.Optional(Type.String({ description: "Origin worktree path or branch. Auto-detected from linkage when omitted." })),
      strategy: Type.Optional(StringEnum(["rebase", "merge", "squash"] as const, { description: "Merge strategy. Omit to use the remembered /land preference (rebase until the user has chosen)." })),
      message: Type.Optional(Type.String({ description: "Commit subject for pending changes / squash. Defaults to the worktree's task." })),
      remove: Type.Optional(Type.Boolean({ description: "Remove the source worktree after a successful land. Default true." })),
      finish: Type.Optional(Type.Boolean({ description: "Conclude an in-progress conflicted merge after resolving files." })),
      abort: Type.Optional(Type.Boolean({ description: "Abort an in-progress conflicted merge." })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const exec = getExec(cwd, signal ?? undefined);
      const remembered = (await loadPrefs()).defaultStrategy;
      const result = await landFlow(exec, cwd, {
        to: params.target,
        strategy: params.strategy ?? (validStrategy(remembered) ? remembered : DEFAULT_STRATEGY),
        message: params.message,
        remove: params.remove !== false,
        finish: params.finish ?? false,
        abort: params.abort ?? false,
        sessionId: ctx.sessionManager.getSessionId(),
      });
      if (result.details.ok) await unbindSession(ctx, result.link);
      return { content: [{ type: "text", text: result.text }], details: result.details };
    },
    renderShell: "self",
    renderCall: silentRender,
    renderResult(result, { expanded, isPartial }, theme) {
      const ink = makeInk(theme);
      const box = (build: string | ((width: number) => string)) =>
        cardBox(1, (t: string) => theme.bg("toolPendingBg", t), typeof build === "function" ? build : () => build);
      if (isPartial) return box(ink.dim("…"));
      const full = (result as { content?: Array<{ text?: unknown }> }).content?.map((b) => (typeof b?.text === "string" ? b.text : "")).filter(Boolean).join("\n") ?? "";
      if (expanded) return box(full);
      const d = (result as { details?: Record<string, unknown> }).details ?? {};
      return box((w) => landText({
        ok: d.ok === true,
        branch: typeof d.branch === "string" ? d.branch : "?",
        dest: typeof d.dest === "string" ? d.dest : "?",
        strategy: typeof d.strategy === "string" ? d.strategy : DEFAULT_STRATEGY,
        sha: typeof d.sha === "string" ? d.sha : null,
        ahead: typeof d.ahead === "number" ? d.ahead : undefined,
        stat: (d.stat ?? undefined) as DiffStat | undefined,
        names: Array.isArray(d.names) ? d.names.map(String) : undefined,
        subjects: Array.isArray(d.subjects) ? d.subjects.map(String) : undefined,
        changes: Array.isArray(d.changes) ? d.changes as FileChange[] : undefined,
        checkpoints: Array.isArray(d.checkpoints) ? d.checkpoints as CheckpointInfo[] : undefined,
        kept: typeof d.kept === "string" ? d.kept : undefined,
        finished: d.finished === true ? true : undefined,
        conflicted: Array.isArray(d.conflicted) ? d.conflicted.map(String) : undefined,
        reason: typeof d.reason === "string" ? d.reason : undefined,
        empty: d.empty === true ? true : undefined,
        cleaned: d.cleaned === true ? true : undefined,
      }, ink, full, w));
    },
  });

  pi.registerTool({
    name: "worktree_abandon",
    label: "Worktree Abandon",
    description:
      "Discard a linked worktree without landing: removes the directory and deletes its branch. Empty worktrees (no commits, clean) are removed immediately; otherwise without confirm:true it only reports what would be lost — confirm with the user first.",
    parameters: Type.Object({
      target: Type.Optional(Type.String({ description: "Branch or path of the worktree. Defaults to this session's bound worktree." })),
      confirm: Type.Optional(Type.Boolean({ description: "Actually delete. Default false = dry run." })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const exec = getExec(cwd, signal ?? undefined);
      const result = await abandonFlow(exec, cwd, { target: params.target, confirm: params.confirm === true, sessionId: ctx.sessionManager.getSessionId() });
      if (result.details.ok) await unbindSession(ctx, result.link);
      return { content: [{ type: "text", text: result.text }], details: result.details };
    },
    renderShell: "self",
    renderCall: silentRender,
    renderResult(result, { expanded, isPartial }, theme) {
      const ink = makeInk(theme);
      const box = (build: string | ((width: number) => string)) =>
        cardBox(1, (t: string) => theme.bg("toolPendingBg", t), typeof build === "function" ? build : () => build);
      if (isPartial) return box(ink.dim("…"));
      const full = (result as { content?: Array<{ text?: unknown }> }).content?.map((b) => (typeof b?.text === "string" ? b.text : "")).filter(Boolean).join("\n") ?? "";
      if (expanded) return box(full);
      const d = (result as { details?: { ok?: unknown; branch?: unknown; commits?: unknown; dirty?: unknown; reason?: unknown } }).details ?? {};
      if (d.ok !== true) {
        const head = firstLine(full);
        return box(d.reason === "needs-confirm" ? head : ink.error(`❌ ${head}`));
      }
      return box((w) => abandonText({
        branch: typeof d.branch === "string" ? d.branch : "?",
        commits: typeof d.commits === "number" ? d.commits : 0,
        dirty: typeof d.dirty === "number" ? d.dirty : 0,
      }, ink, w));
    },
  });

  // ---------------------------------------------------------------- commands

  pi.registerCommand("worktree", {
    description: "Isolate work in a fresh linked worktree — the agent names it, carries related changes, and continues there",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const cwd = ctx.cwd;
      const exec = getExec(cwd, ctx.signal ?? undefined);
      const parsed = parseWorktreeArgs(args);

      if (parsed.help) {
        emit(ctx, [
          "/worktree [task...] [--branch <name>] [--base <ref>] [--path <path>] [--no-carry] — isolate work in a fresh worktree. The agent names it, carries only related changes, and continues there. No questions asked.",
          "/land — preview and merge the worktree back when done.",
          "Status, abandon and conflicts are the agent's job — just describe what you want.",
        ].join("\n"), "info");
        return;
      }
      // Retired subcommands: point at the agent instead of managing anything.
      if (!parsed.branch && ["list", "ls", "status", "st", "prune"].includes(parsed.task.toLowerCase())) {
        emit(ctx, "Worktree 状态和清理不用你操心 — 直接告诉 agent 要做什么，剩下的它来。", "info");
        return;
      }

      const facts = await collectFacts(exec, cwd);
      if (!facts) {
        emit(ctx, "Not a git repository.", "error");
        return;
      }
      const hasHistory = ctx.sessionManager.getEntries().some((e) => e.type === "message");

      // Two cases create directly with zero dialogs. Everything else is
      // model-driven (below): the model triages dirty files and names the
      // branch itself — the command never asks and never forces a format.
      //   - fast path: the user named the branch AND there is nothing to
      //     triage (clean workspace, or carry disabled).
      //   - empty edge: no task and no conversation — nothing to infer a
      //     task or a name from, so create and wait instead of an awkward turn.
      if ((parsed.branch && (facts.clean || !parsed.carry)) || (!parsed.task && !hasHistory)) {
        const r = await createFlow(exec, cwd, {
          branch: parsed.branch,
          base: parsed.base,
          path: parsed.path,
          carry: parsed.carry,
          task: parsed.task,
          sessionId: ctx.sessionManager.getSessionId(),
        });
        if (!r.ok) {
          emit(ctx, r.text, "error");
          return;
        }
        await bindSession(ctx, r.link);

        const owed = "When done, write the paragraph the user is owed — what changed, what you verified, what the conclusion is — then call worktree_land; the host puts the approval to the user (never land silently, never ask for approval in prose).";
        const ready = `Worktree ready: \`${r.branch}\` at ${r.path} — ${r.carryNote}.`;
        if (!ctx.hasUI) emit(ctx, ready, "info");
        // The receipt first, then the user's own words. A prompt typed after `/worktree` is a
        // prompt: sending it as a user message — rather than quoting it inside an extension note —
        // is what keeps their transcript their own. A quoted string loses their formatting, turns
        // their screenshot into a bare path, and leaves them with no message to read.
        pi.sendMessage(
          {
            customType: CARD_TYPE,
            content: parsed.task
              ? ready
              : `${ready}\nUser ran /worktree with no task text. This session is bound to ${r.path} — relative paths and bash already run there. Infer the pending task from the conversation and do it. ${owed}`,
            display: true,
            details: {
              kind: "create", from: r.from ?? facts.branch ?? "?", branch: r.branch,
              carried: r.carriedPaths, changes: r.carriedChanges,
              total: r.totalDirty, selective: r.selective, clean: r.clean,
            } satisfies CardDetails,
          },
          { triggerTurn: !parsed.task },
        );
        if (parsed.task) {
          pi.sendUserMessage(parsed.task);
        } else if (ctx.hasUI && !hasHistory) {
          ctx.ui.notify(`🌲 ${r.branch} ready — tell me what to do there.`, "info");
        }
        return;
      }

      // Model-driven isolation. The handoff stays invisible (display:false):
      // the transcript shows a single purple WORKTREE block once the model
      // creates it. Cards signal; the model speaks.
      // Typing /worktree already answered the question the gate would ask.
      gate.arm("create");
      const dirty = facts.porcelain.split("\n").filter(Boolean);
      const lines = [
        parsed.task
          ? "The user's request is the message above. Isolate that work into a new linked worktree."
          : "User ran /worktree with no task text — infer the pending task from the conversation and the dirty files below, then create the worktree and do it. Never come back with a question about what to work on: if nothing pending is inferable, still create it and say in one line that it's ready for whatever comes next.",
        `Origin: ${facts.branch ?? "?"} @ ${facts.topLevel}.`,
        "Isolate the work into a new linked worktree YOURSELF by calling worktree_create — never use raw git worktree commands. Don't ask the user anything — just open the worktree.",
        "1. The dirty files are listed below — triage from this list. Call worktree_status only if you need more (current branch, existing worktrees).",
        parsed.carry
          ? "2. Triage uncommitted changes: carry only files related to this task via `carryPaths`; leave unrelated files untouched in the origin. If everything dirty belongs here, omit `carryPaths` to carry all. If you carry selectively, tell the user in one line which files you left behind and why."
          : "2. The user passed --no-carry: create without carrying any uncommitted changes.",
        parsed.branch
          ? `3. Use branch \`${sanitizeBranchName(parsed.branch) || parsed.branch}\`.`
          : "3. Name the branch yourself via `branch` — a descriptive name for this work, never a fixed or date-based format. If no task is inferable, pick a short generic name instead of asking.",
      ];
      if (parsed.base) lines.push(`Base the branch on \`${parsed.base}\`.`);
      if (parsed.path) lines.push(`Create the worktree at \`${parsed.path}\`.`);
      if (dirty.length > 0) {
        lines.push(`Dirty files right now (${dirty.length}):`);
        for (const f of dirty.slice(0, 30)) lines.push(`  ${f}`);
        if (dirty.length > 30) lines.push(`  … ${dirty.length - 30} more`);
      }
      lines.push("Then continue the task inside the new worktree (tool calls are re-rooted there automatically). When done, write the paragraph the user is owed — what changed, what you verified, what the conclusion is — then call worktree_land; the host puts the approval to the user (never land silently, never ask for approval in prose).");
      const instruction = lines.join("\n");
      if (!ctx.hasUI) emit(ctx, instruction, "info");
      // The how-to stays out of the transcript; the prompt the user typed goes in as their own
      // message, so the bubble they wrote is the message the model answers.
      pi.sendMessage(
        {
          customType: CARD_TYPE,
          content: instruction,
          display: false,
          details: undefined,
        },
        { triggerTurn: !parsed.task },
      );
      if (parsed.task) pi.sendUserMessage(parsed.task);
    },
  });

  /** The tool each kind of question is about — what a yes hands back to the model. */
  const GATE_TOOL: Record<GateKind, string> = {
    create: "worktree_create",
    land: "worktree_land",
    abandon: "worktree_abandon",
  };

  /**
   * The human's answer to a question the conversation is holding.
   *
   * A window's card calls this by name; a terminal user can type it. It never does the work itself
   * — a yes arms the gate and hands the model back the call it already made, so the tool runs once,
   * where it has always run, with the parameters it was called with. A no is recorded, so a retry
   * in the same run is blocked without a second card.
   */
  pi.registerCommand("worktree-answer", {
    description: "Answer the worktree question the agent is waiting on: /worktree-answer yes|no",
    getArgumentCompletions: (prefix: string) =>
      ["yes", "no"]
        .filter((v) => v.startsWith(prefix.trim().toLowerCase()))
        .map((value) => ({ value, label: value })),
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const open = pendingAsk;
      if (!open || open.card.answer) {
        emit(ctx, "Nothing is waiting for an answer.", "info");
        return;
      }
      const kind = open.card.kind;
      const yes = /^(y|yes|ok|approve|open|land|discard)/i.test(args.trim());
      gate.answered(kind, yes);
      // The card keeps its place, marked with the answer and stripped of its buttons. A question
      // that vanishes under the pointer leaves the person who answered it with nothing to check,
      // and the run it hands back to the model is where they watch what their answer did.
      pendingAsk = { ...open, card: { ...open.card, answer: yes ? "yes" : "no" } };
      await refreshChrome(ctx, ctx.cwd);

      const what = kind === "create" ? "open a worktree" : kind === "land" ? "land the worktree" : "abandon the worktree";
      const content = yes
        ? [
            `The user approved: ${what}.`,
            `Lead with the paragraph they are owed — what changed, what you verified, what the conclusion is — then call \`${open.toolName}\` again with exactly these parameters: ${JSON.stringify(open.params).replace(/\{\}/, "{}")}. The approval is recorded, so it will run.`,
          ].join(" ")
        : `The user declined to ${what}. Do not retry; continue where the work already is and say in one line that you stayed.`;
      pi.sendMessage({ customType: CARD_TYPE, content, display: false }, { triggerTurn: true });
    },
  });

  pi.registerCommand("land", {
    description: "Land the bound worktree straight into its origin (strategy remembered; override: /land --strategy squash)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const cwd = ctx.cwd;
      const exec = getExec(cwd, ctx.signal ?? undefined);
      const me = ctx.sessionManager.getSessionId();
      const ui = ctx.hasUI;
      const parsed = parseLandArgs(args);

      if (parsed.help) {
        emit(ctx, [
          "/land [target] [--strategy rebase|merge|squash] — land straight, no questions.",
          "The merge strategy is asked once, remembered across repos, and shown on every land line.",
          "An explicit --strategy wins for this run and becomes the new default.",
        ].join("\n"), "info");
        return;
      }
      if (parsed.badStrategy !== undefined) {
        emit(ctx, `Unknown strategy \`${parsed.badStrategy}\` — want rebase, merge, or squash.`, "error");
        return;
      }
      // The user asked to land: the gate has nothing left to ask about, including the
      // finish:true call that concludes a conflict this command started.
      gate.arm("land");

      // Zero popups by design: no strategy picker, no child picker, no
      // foreign-owner confirm. Blocks and ambiguity surface as purple cards.
      const result = await landFlow(exec, cwd, {
        to: parsed.target,
        strategy: DEFAULT_STRATEGY,
        remove: true,
        finish: false,
        abort: false,
        sessionId: me,
        review: async (p) => {
          if (parsed.strategy) {
            await savePrefs({ defaultStrategy: parsed.strategy });
            return { strategy: parsed.strategy, message: p.message };
          }
          const saved = (await loadPrefs()).defaultStrategy;
          if (validStrategy(saved)) return { strategy: saved, message: p.message };
          if (ui) {
            const pick = await ctx.ui.select("How should /land merge from now on?", [
              "Rebase — linear, fast-forward",
              "Squash — one commit",
              "Merge — keep history",
            ]);
            if (!pick) return undefined;
            const strategy: Strategy = pick.startsWith("Squash") ? "squash" : pick.startsWith("Merge") ? "merge" : "rebase";
            await savePrefs({ defaultStrategy: strategy });
            return { strategy, message: p.message };
          }
          return { strategy: DEFAULT_STRATEGY, message: p.message };
        },
      });

      const rd = result.details as {
        ok?: boolean; reason?: string; sha?: string | null; strategy?: string;
        branch?: string | null; dest?: string; source?: string; target?: string;
        ahead?: number; stat?: DiffStat; names?: string[]; subjects?: string[]; changes?: FileChange[];
        checkpoints?: CheckpointInfo[]; kept?: string | null; finished?: boolean;
        conflicted?: string[]; empty?: boolean; cleaned?: boolean;
      };
      if (rd.reason === "cancelled") {
        emit(ctx, "Cancelled — pick a strategy next time and it sticks.", "info");
        return;
      }
      if (rd.ok) await unbindSession(ctx, result.link);
      if (!ui) emit(ctx, result.text, rd.ok ? "info" : "error");

      // Conflict is the model's job, not the user's: it resolves, finishes and
      // explains. The card carries the file list; the instruction below tells
      // the model to handle it and only escalate genuine ambiguity.
      if (!rd.ok && rd.reason === "conflict") {
        const branch = rd.branch ?? "?";
        const dest = rd.dest ?? "?";
        pi.sendMessage(
          {
            customType: CARD_TYPE,
            content: [
              result.text,
              `Resolve it yourself: read each conflicted file, keep the intended result from both sides (task changes win on task files, origin changes win elsewhere), \`git add\` them, then finish with worktree_land finish:true (or conclude the /land). If you genuinely cannot tell which side is intended because both look deliberate, ask the user with both versions quoted. Explain the resolution in your own words when done.`,
            ].join("\n"),
            display: true,
            details: {
              kind: "land", ok: false, branch, dest,
              strategy: rd.strategy ?? DEFAULT_STRATEGY, sha: null,
              conflicted: rd.conflicted, reason: "conflict",
            } satisfies CardDetails,
          },
          { triggerTurn: true },
        );
        await refreshChrome(ctx, cwd);
        return;
      }

      if (rd.ok) {
        pi.sendMessage(
          {
            customType: CARD_TYPE,
            content: result.text,
            display: true,
            details: {
              kind: "land", ok: true,
              branch: rd.branch ?? "?", dest: rd.dest ?? "?",
              strategy: rd.strategy ?? DEFAULT_STRATEGY, sha: rd.sha ?? null,
              ahead: rd.ahead, stat: rd.stat, changes: rd.changes, names: rd.names, subjects: rd.subjects,
              checkpoints: rd.checkpoints, kept: rd.kept ?? null, finished: rd.finished,
              empty: rd.empty, cleaned: rd.cleaned,
            } satisfies CardDetails,
          },
          { triggerTurn: true },
        );
      } else {
        pi.sendMessage(
          {
            customType: CARD_TYPE,
            content: result.text,
            display: true,
            details: { kind: "error" } satisfies CardDetails,
          },
          { triggerTurn: false },
        );
      }
      await refreshChrome(ctx, cwd);
    },
  });

  // ------------------------------------------------------------------ events

  pi.on("session_start", async (_event, ctx) => {
    const exec = getExec(ctx.cwd, ctx.signal ?? undefined);
    await resolveBinding(exec, ctx.cwd, ctx.sessionManager.getSessionId());
    await refreshChrome(ctx, ctx.cwd);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      if (ctx.mode === "tui") {
        ctx.ui.setWidget(WIDGET_KEY, undefined);
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
      publishBinding(ctx, undefined);
    } catch {
      // Ignore teardown races.
    }
  });

  // Keep the readiness line (↑ commits, dirty count) honest after each run.
  pi.on("agent_end", async (_event, ctx) => {
    // One answer per run. A question still on screen is not erased with it: the card stays until
    // the user clicks, which is why `open` and the pending card outlive this. An answered card does
    // end with the run it handed back — by then the receipt of what it asked for is in the
    // transcript, and the turn folds like any other.
    gate.reset();
    if (pendingAsk?.card.answer) pendingAsk = null;
    await refreshChrome(ctx, ctx.cwd);
  });

  // Two jobs on the same hook, in this order: the approval gate, then the virtual cwd.
  // The gate comes first because it is about whether the call happens at all.
  pi.on("tool_call", async (event, ctx) => {
    const params = (event.input ?? {}) as Record<string, unknown>;
    const kind = gateKind(event.toolName);
    const verdict = gate.decide({
      toolName: event.toolName,
      hasUI: ctx.hasUI,
      params,
      saidToUser: saidToUser(ctx),
    });
    if (kind && verdict !== "allow") {
      if (verdict === "explain") {
        // No card, no answer held, and the turn goes on: the model writes the paragraph and asks
        // again, and the question is put to the user under it.
        return { block: true, reason: explainFirstReason(kind) };
      }
      if (verdict === "deny") {
        const open = gate.openKind();
        return {
          block: true,
          reason: open && open !== kind ? waitingOnOtherReason(open, kind) : deniedReason(kind),
        };
      }
      try {
        const exec = getExec(ctx.cwd, ctx.signal ?? undefined);
        // A card is the question. No card means there is nothing to put in front of the user — no
        // repository, no link, or a worktree with nothing in it — and the tool's own answer is the
        // better one: blocking there would end the run with a question nobody can see or answer.
        const card = await askCard(exec, ctx.cwd, kind, params, ctx.sessionManager.getSessionId());
        if (!card) return;
        if (ctx.mode === "tui") {
          // A terminal has nowhere of its own to put a card, so the question is a dialog — painted
          // with the same rows a window composes from the same card.
          const ok = await ctx.ui.confirm(GATE_TITLES[kind], paintAsk(card, plainInk, 60));
          gate.answered(kind, ok);
          if (!ok) return { block: true, reason: deniedReason(kind) };
        } else {
          // A window draws the question where the call itself is: the call stops here, the row in
          // the transcript becomes the card with its buttons, and the answer comes back as
          // /worktree-answer. Nothing is asked twice — a retry while the card is still open is
          // blocked without a second card.
          gate.asked(kind);
          pendingAsk = { card: { ...card, id: event.toolCallId }, toolName: event.toolName, params };
          await refreshChrome(ctx, ctx.cwd);
          ctx.ui.notify(`${GATE_TITLES[kind]} Waiting in the conversation.`, "info");
          return { block: true, reason: awaitingReason(kind), terminate: true };
        }
      } catch {
        // A question that cannot be asked must not swallow the call: what fails to be *drawn* is not
        // a reason to hold the work, and the tool is about to answer for itself anyway.
        gate.answered(kind, true);
      }
    }

    if (!binding || binding.standingInside) return;
    try {
      const r = rewriteToolInput(event.toolName, event.input as Record<string, unknown>, binding, ctx.cwd);
      if (r.block) return { block: true, reason: r.block };
    } catch {
      // Never let re-rooting break a tool call.
    }
    return;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    try {
      const exec = getExec(ctx.cwd, ctx.signal ?? undefined);
      const facts = await collectFacts(exec, ctx.cwd);
      if (!facts) return;
      const b = await resolveBinding(exec, ctx.cwd, ctx.sessionManager.getSessionId());
      const canon = await canonicalPath(facts.topLevel);
      const kids = facts.commonDir ? childrenOf(await loadStore(facts.commonDir), canon) : [];
      const section = buildPolicySection({
        branch: facts.branch,
        clean: facts.clean,
        worktreeCount: facts.worktrees.length,
        bound: b
          ? { root: b.root, branch: b.branch, originBranch: b.originBranch, originPath: b.origin, standingInside: b.standingInside, task: b.task }
          : null,
        childCount: kids.length,
        childBranches: kids.map((k) => k.branch),
      });
      return { systemPrompt: `${event.systemPrompt}\n\n${section}` };
    } catch {
      return;
    }
  });
}
