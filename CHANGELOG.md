# Changelog

All notable changes to `pid-worktree` are documented here.

## [Unreleased]

### Added

- **The worktree line started counting, and stopped being a sentence.** It carries the worktree's
  whole state against its origin — `4 files`, `+58`, `−11`, ahead, dirty — read with the same
  commands the tool would use, committed and uncommitted together (a two-dot diff on purpose), so the
  number moves while you work instead of only when you commit. A quiet worktree shows no numbers
  rather than `0 files`. It sits on the session title bar's second line, beside the folder, and is
  drawn as objects rather than as text: the branch and where it lands are one tinted chip, the line
  counts keep green and red, and the rest stays quiet — a row to read at a glance instead of parse.
- **Claiming the header no longer costs the branch.** PID stands its own branch chip down as soon as
  any extension registers a header, so a session sitting in a repo with no worktree showed a folder
  and nothing else. The chrome publishes the branch too, drawn as the plain faint name PID would have
  shown — nothing added, nothing to explain.
- **Only this session's own worktree is shown, and only while it is open.** A window used to get a
  roll-up instead: the origin's children, or every repo under a folder that is not itself a repo
  (`🌲 8 projects · all on their own branch`). Both are someone else's worktree, in a line whose whole
  justification is that *this* session opened one. A session with nothing open now says nothing, and
  the workspace view is gone entirely — along with the project discovery that existed to feed it.
- **Every worktree-changing tool call the agent starts on its own is put to the user first.**
  `worktree_create`, `worktree_land` and `worktree_abandon` are stopped in the `tool_call` hook and
  turned into a question carrying the numbers that matter — the branch, how many files carry and
  which, the commits and files a land would merge, the strategy it would use. `worktree_status` is
  never gated: reading git state is not a decision. Details:
  - **A window is asked in the transcript, not in a modal.** The call is stopped, the card appears on
    the row where the call itself is, and two buttons answer it — the run ends cleanly instead of a
    dialog taking the window to ask one question. The card is composed from `ask-view.ts` with PID's
    own primitives, so `+12` is green, `−3` is red, and a status letter is a tinted badge.
  - **The question stays in sight after the run.** The run ending is what folds a finished turn's
    steps behind one `Worked for …` line, and the card is one of those steps — so the row says
    `asks` while the question stands and PID leaves it unfolded. Buttons that a fold can take away
    are not buttons.
  - **A terminal is asked in a dialog**, because it has nowhere else to put a card — painted from the
    same fields, so both surfaces show the same rows.
  - **The answer is a command, not a second tool**: `/worktree-answer yes|no`. A yes arms the gate
    and hands the model back the call it already made, parameters and all, so the tool runs once,
    where it has always run. That also means the buttons work by hand and by keyboard.
  - **A command the user typed is already the answer.** `/worktree` arms `create` and `/land` arms
    `land`, so a decision just made is not asked again; `abort:true` (the undo, not the landing)
    passes for the same reason.
  - **One answer per run, both ways.** A yes is remembered, so a conflict's `finish:true` does not
    re-ask; a no is remembered too, and a retry is blocked without a second card. A question still on
    screen outlives the run that raised it and is only cleared by an answer.
  - **No dialogs, no questions.** In print and json runs (`ctx.hasUI === false`) everything is
    allowed — a question nobody can answer must not hang the agent.
  - **The model says what it did, in its own words, before it lands.** The card carries the numbers
    and no card can say what was decided, what was verified or what is still unsure — so the recap
    is asked for everywhere the model looks: the `worktree_create`/`worktree_land` guidelines, the
    bound-session policy, the `/worktree` hand-off, and the approval hand-back that sends it to
    re-issue the call. It writes the paragraph, then the call goes to the user.
  - The policy now says the host asks, so the model calls the tool instead of raising the question in
    prose, and a blocked call tells it to stop trying and continue where the work already is.

### Fixed

- **The card waits for the model to say what it is about.** A gated call that carried no words for
  the user used to raise its card anyway, so the question arrived with nothing above it — the user
  being asked to approve something nobody had described. The call is now stopped *before* a card
  exists (nothing drawn, nothing held, the turn continues), and the model is told to write the
  paragraph and ask again. Once per kind per run: a model that ignores it gets its card, because a
  nudge that can loop is worse than a quiet card.

- **A question is a card, so no card means no question.** Three cases ended a run with a question
  nobody could see: no repository, no link to describe, and a worktree with nothing in it (the
  landing is cleanup, not a decision). The call runs now and the tool's own answer is the row. The
  card that used to appear for the empty case read `nothing new · nothing to clean` — an approval
  for nothing, which is not a question either.
- **One question at a time.** Two open cards left the first unattachable: the buttons answer the
  newest, so clicking the first one answered the second. A second gated call is held with a reason
  that says which question is in the way, and the model is told to wait rather than to retry.
- **`worktree_abandon confirm:false` is not a question.** The dry run deletes nothing; only the real
  one is put to the user.
- **A land card no longer says `nothing new · nothing to clean` over uncommitted work.** It counted
  `base..HEAD` alone, so a worktree whose work was still in the working tree — the ordinary case,
  because the agent finishes before it commits anything — was put up for approval as nothing at all:
  the paragraph above it described two changed files and the card below it denied them. The card now
  counts what the landing actually carries: the commits ahead, the uncommitted work as the single
  checkpoint commit it will write (task as subject, so it counts), the untracked files a two-dot
  diff cannot see, and the origin's own pending files, which the landing checkpoints before it
  merges — the last one is work in *someone's* working tree, and approving a landing that commits it
  should say so.

- **A window showed no worktree at all.** `refreshChrome` read `ctx.ui.theme` before doing anything
  else and then painted with it — but PID's worker hands out `theme: undefined` (its theme list is
  empty when the extension context is built) while declaring the member served. The read threw, the
  function's own `catch` swallowed it, and **nothing was ever published**: no binding, no children,
  no line above the conversation. The chrome paints only for a terminal now, outside one it never
  touches the theme, and the binding is published either way. Caught by driving PID itself headless
  (`PID_HEADLESS=1 PID_DUMP_DIR=…`, an invisible window that dumps what it painted) rather than by
  reading the code.
- **A window no longer shows the worktree twice.** The ANSI-painted widget line and the status
  belong to a terminal; a host that is not one was handed them *and* the `worktree:binding/v1`
  payload, so PID painted the binding in the session title bar and the stripped string in the
  strip below it. Non-terminal hosts now get only the payload.

### Changed

- **Renamed to `pid-worktree`, everywhere, with the migrations to match.** Package, repository,
  linkage directory (`<git-common-dir>/pid-worktree/`), preferences file
  (`~/.pi/agent/pid-worktree/config.json`), widget and status keys, session entry types and the
  carry-stash label all take the new name. Nothing is asked of the user:
  - links written under the old directory, and the even older single `pi-worktree.json`, are read
    and merged on load;
  - preferences found at the old path are read once and written forward, after which the new file
    answers on its own. The old file is left where it is — it is the user's;
  - cards already written into a session file carry the old `customType`, so that name stays
    registered against the same renderer and old transcripts keep drawing.
- **One session, one tree.** A bare land/abandon resolves only the calling session's own link (or the worktree you're standing in) and never auto-grabs another session's worktree — the `Blocked: … belongs to another session` error is replaced by a `no-own-link` note that lists the others and leaves them alone. Naming a link explicitly still takes it over deliberately, flagged `foreign` with the previous owner named, and the model reports it in chat.
- **No-task `/worktree` never comes back with a question.** With conversation history it infers the pending task and creates the worktree; when nothing is inferable it still creates it and says in one line that it's ready — the old "ask what to work on" escape hatch is gone, because typing `/worktree` means you want the tree. Only with no conversation at all does it create silently and wait for you.
- **Conflicts are the model's job.** `LAND CONFLICT` still names the files in one purple card, but instead of stopping for hand resolution the model reads each file, keeps the intended result from both sides, `git add`s and finishes — explaining what it kept. It only asks the user when both sides look deliberately contradictory.
- **LAND cards separate commits from files.** The commit count and subjects now have their own section, followed by a distinct file count and path list, so the landed history is easy to scan.

### Fixed

- **`/land` on an empty worktree cleans up instead of erroring.** Landing a worktree with no commits and no changes used to fail with `Nothing to land … Use worktree_abandon to drop the worktree`, forcing a second manual step. Now it removes the worktree directory, deletes the branch, clears the link and unbinds the session in one go (`LAND 【x -> main】 · nothing new · cleaned up`). `worktree_abandon` without `confirm:true` also drops empty worktrees immediately — confirmation is only needed when commits or dirty files would be lost.

### Changed

- **Transcript visual language: one diagram tree per card.** Every action renders exactly one purple block: a caps `LABEL` plus the hero in `【】`, then the payload hanging off a `├─`/`└─`/`│` diagram (`WORKTREE` 【main -> x】, `LAND` 【x -> main】 · rebased as a1b2c3d — the verb says what happened, the sha names where the target landed). Counts are bright, nouns dim, names readable; conflict files stay brightest because they need action; the `│` stems are painted like the `├─`/`└─` glyphs so the tree reads as one piece. Every row is listed — no `+N more` cap on commits or files. File rows (`WORKTREE` carried files and `LAND` landed files) are a table: status letter (`N` new, `U` updated, `D` deleted, `R` renamed), path, and `+N`/`-N` line counts with additions green, deletions red, zeros dim; columns are padded to the widest cell so the list reads as a grid and long paths are clipped by display width from the front, keeping the file name. Cards are width-aware and commit subjects **wrap with a hanging indent under the text** instead of being clipped — nothing is hidden, and the tree stays aligned on any terminal. The LAND card shows a `N files checkpointed on <branch>` row only for the origin side — the worktree's own checkpoint is folded into the landed commits it produced, so the same subject never appears twice.
- **`/worktree` is model-driven.** No confirmation, ever. The agent triages dirty files (selective stash via `carryPaths`, saying in one line what it left behind and why) and names the branch itself — no fixed format. Tool-side collisions auto-bump (`-2`, `-3`); an explicit human `--branch` still errors on collision so typos stay visible.
- **`/land` runs straight with zero popups** (`/land [target] [--strategy …]`). The strategy is asked once, remembered globally (`~/.pi/agent/pi-worktree/config.json`), shown on every land line; an explicit `--strategy` wins and becomes the new default. Ambiguity and foreign-owned links surface as purple cards instead of dialogs.
- **Conflict is the one full stop.** A purple `LAND CONFLICT` block names the files and stops — no auto-resolve. The model explains in its own words, asks how to proceed, and never calls `finish:true` without explicit user consent.
- Auto-checkpointed files are announced as their own `DIRTY WORKTREE` section, and land lines carry landed commit subjects plus the file list.
- `worktree_status` renders nothing (triage plumbing); global install tracks the local repo for development.

### Fixed

- **Selective carry no longer dies on a staged deletion.** `git stash push -u -- <path>` fails with `pathspec … did not match any files` when the path names a *staged* deletion (and leaks an empty stash entry doing it), so `worktree_create` with `carryPaths` covering a deleted file reported `carry skipped` and moved nothing. The scope is now expressed as exclusions (`:(exclude,literal)` over the dirty paths that stay behind), which matches index and worktree state alike — deleted files carry, unrelated files stay, no stash leaks.
- **A bad `/land` target is no longer misreported as detached HEAD.** When the target path does not exist (e.g. `/land /repo/然后推送到` — text glued to the path), every git probe fails and `git symbolic-ref` exits 128; that exit code used to be read as "detached HEAD", sending the session hunting for a fix in a target that was never checked out. `isDetached` now trusts only exit 1, and land validates the target with `rev-parse --is-inside-work-tree` first, reporting `Target … is not a git work tree — no such directory, or not a repository` (`bad-target`).
- **Stash leak:** `git stash drop` only accepts `stash@{n}` refs, never a raw sha — every carry used to leave an orphan `pi-worktree:*` stash entry. Now locates the entry by sha and drops it; tests assert an empty stash list after carry.

## [0.2.0] - 2026-09-04

### Added

- **Session binding (virtual cwd).** While a session owns an active worktree, built-in tool calls are re-rooted there via `tool_call`: bash starts inside the worktree, relative and omitted paths resolve against it, and `edit`/`write` aimed at the origin checkout are blocked with the worktree twin. The per-turn policy now states a single `Working root` instead of contradicting the handoff with origin-side facts.
- **`/land` preview and choice.** One-line summary (commits, diff stat, uncommitted files, how far the origin moved) then rebase→ff (default), squash, merge, or edit the commit subject. Conflicts offer agent / abort / manual on the spot. Several children at the origin open a picker.
- **`rebase` land strategy** (default): rebase the worktree onto the origin and fast-forward — linear history, no merge commit. Falls back to merge when the rebase conflicts, after aborting it.
- **`worktree_abandon` tool**: discard a worktree; dry run without `confirm:true` reports what would be lost. Refuses `main`/`master`, other sessions' links, and running from inside the worktree.
- Task text is stored on the link and drives the branch name (`wt-fix-login-retry`), the land commit subject, the widget and the session name.
- Widget readiness: `↑ahead · ↓behind · N dirty`, refreshed after every agent run; terminal title follows the bound worktree.

### Changed

- Store is one file per link in `<git-common-dir>/pi-worktree/`; sessions only write their own link, ending the load-modify-save race between parallel sessions. Legacy `pi-worktree.json` migrates on first load.
- `/worktree` grammar: every positional is task text; explicit branch names go through `--branch`. `/worktree cleanup` is a task again, not a branch.
- `/worktree` with no task and no conversation creates the worktree and waits instead of triggering a turn that has nothing to infer.
- Land/abandon restore the pre-worktree session name (or `✓ <branch>`).
- Detached `HEAD` is now blocked on the target side too; squash with nothing new reports `nothing-to-land` instead of a conflict.
- Target checkpoints are `wip(<branch>): checkpoint before landing …`; source checkpoints use the task as subject.

### Verification

- 35 tests passing (`npm test`), including re-rooting rules, per-link store isolation, legacy migration, rebase→ff and rebase-conflict fallback against real git.
- `tsc --noEmit` clean.
- Print-mode round trip against real Pi: `/worktree add retry tests --yes` → `wt-add-retry-tests` with carried changes → `/land` from inside the worktree lands as a single fast-forwarded commit titled `add retry tests`, cleans up, and restores the session name.

## [0.1.1] - 2026-09-04

### Changed

- `/worktree` is one shot: free text after the command is treated as the task (branch names only match single ASCII tokens), the agent auto-continues inside the new worktree, and asks before landing — no more idle script-like stops. Both commands trigger the next model turn instead of queueing `nextTurn` messages.
- Auto branches are short flat `wt-*` (`wt-0904-1111`) and bump `-2`/`-3` on collision, so fresh sessions never hit `already exists`; explicit names still error to keep typos visible.
- `/land` from the origin side auto-flips to the single active child, and dirty targets are checkpoint-committed instead of erroring.
- Display overhaul: two-line result cards (full output one expand away), short widget/status lines, no absolute-path repetition, session renamed to the worktree branch for session isolation.
- Session-exclusive worktrees: links record the owning session; landing another session's active link is blocked for tools and confirm-gated for `/land` (standing inside the worktree counts as possession, so cd-and-land keeps working). The widget/status show only own plus unowned links; the full list stays in `/worktree status` and the model policy.
- Self-healing linkage: every land/widget/create pass reconciles the store against `git worktree list`, so externally removed worktrees stop haunting flip/ownership logic — never hand-edit the JSON.
- DWIM land direction: naming a linked child from its origin lands it here; standing on `main` beside one unlinked worktree lands it here. Cleanup never suggests deleting `main`/`master` or removing a main working tree.
- One active worktree per session per repo: repeat creates are blocked with a pointer back at the owned link (land it first). `/worktree prune` now also heals stale store links.
- Two-command surface: `/worktree` (create one-shot) and `/land` (bare one-shot). `list`/`status`/`prune` subcommands and all `/land` flags are gone from user space — status, prune, conflict continuation and strategy live in the tools + policy for the model. Sync also prunes git metadata quietly, so no manual prune entry is needed.

## [0.1.0] - 2026-09-04

### Added

- `/worktree [branch] [--base <ref>] [--path <path>] [--no-carry]` creates a linked worktree on a new branch, carrying uncommitted changes (tracked plus untracked) via a temporary stash; clean workspaces take a stash-free fast path.
- `/worktree list` (`status`), `/worktree prune`, and `/worktree help` subcommands.
- `/land [--to <path|branch>] [--strategy merge|squash] [-m <msg>] [--no-remove] [--yes]` commits pending source changes, refuses dirty targets, merges back, and cleans up (`worktree remove` plus `branch -d`) on success.
- Conflict flow: conflicted files are listed, `MERGE_HEAD` is left in place, `/land --continue` concludes after resolution and `/land --abort` rolls back; both work from either worktree.
- `worktree_status`, `worktree_create`, and `worktree_land` agent tools, plus a per-turn system-prompt policy that proactively isolates experimental, risky, or parallel work when the workspace is clean.
- Origin↔worktree linkage in `<git-common-dir>/pi-worktree.json` so `/land` survives `cd` plus fresh sessions; TUI widget and footer status for linked children and origins.
- Safety rails: no pushes, no `-D` branch deletes, stash dropped only on clean apply, dirty-target and same-path lands blocked, detached-`HEAD` sources blocked with a hint.

### Verification

- Unit plus real-git end-to-end suite: 14 tests passing (`npm test`).
- `tsc --noEmit` clean.
- Print-mode round trip verified against real Pi: dirty carry, `--yes` land with auto-cleanup, and abort/continue through a forced conflict.
- Public GitHub distribution as a Pi package (`jinhuang712/pi-worktree`).
