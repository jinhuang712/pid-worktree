# pid-worktree

A native [Pi](https://github.com/badlogic/pi-mono) extension for git worktree flow: `/worktree` isolates work into a linked worktree and binds the session to it, `/land` merges it back with linear history.

`pid-worktree` shells out to your own `git` for all repository mutations and keeps one linkage file per worktree inside the shared git dir, so the mapping survives `cd` plus fresh Pi sessions on either side. The agent gets four tools (`worktree_status`, `worktree_create`, `worktree_land`, `worktree_abandon`) and a short per-turn policy: when the workspace is clean and the task is experimental, risky, or parallel, it proactively isolates instead of editing in place.

## Mental model

One origin, one child, one round trip. Everything else is detail.

```text
  ORIGIN                              WORKTREE
  ------                              --------

  main @ ~/repo                       wt-fix-login @ ~/repo.worktrees/wt-fix-login
  +--------------+                     +------------------+
  |  A --- B     |                     |  A --- B         |
  |  (clean or   |  /worktree          |  (bound session  |
  |   dirty)     | ------------>       |   works here)    |
  +--------------+  carry via stash    +------------------+
        ^                                      |
        |                 /land                |
        +----------------<---------------------+
              rebase (default) / merge / squash
```

Lifecycle states for a link:

```text
  active ------------------> landed ---> removed
    |                         ^
    +--> removed (abandoned) --+
```

- `active`: the worktree exists and the session is bound to it.
- `landed`: commits were merged into the origin.
- `removed`: worktree directory (and usually the branch) is cleaned up.

## Installation

Install the public GitHub package:

```bash
pi install git:github.com/jinhuang712/pid-worktree
```

Or install it locally while developing:

```bash
pi install -l /absolute/path/to/pid-worktree
```

Restart Pi after installation so it discovers the extension.

## Quick start

```text
/worktree add retry on 429 for the http client
# ... agent works in isolation, bound to the new worktree ...

/land
```

What you see: exactly one purple card per action, one diagram tree under the `【hero】`, every item listed (no caps), file rows aligned as a table — status letter (`N` new, `U` updated, `D` deleted, `R` renamed), path, `+N`/`-N` counts:

```text
🌲 WORKTREE 【main -> wt-http-retry】
   └─ carrying 2 of 5 files · 3 left in origin
      ├─ U  src/http.ts        +12  -3
      └─ N  test/http.test.ts  +40  -0

🌲 LAND 【wt-http-retry -> main】 · rebased as a1b2c3d
   ├─ 2 commits
   │  ├─ feat(http): retry on 429
   │  └─ test(http): cover retry exhaustion
   └─ 4 files
      ├─ U  src/http.ts          +12   -3
      ├─ N  test/http.test.ts    +40   -0
      ├─ U  README.md             +6   -1
      └─ D  src/legacy-http.ts    +0  -58
```

## /worktree — isolate

```text
/worktree [task...] [--branch <name>] [--base <ref>] [--path <path>] [--no-carry]
```

### What happens

```text
  Step 1: triage              Step 2: create             Step 3: bind
  ----------------            ----------------           ----------------

  origin status               git worktree add           session sticks to
  CLEAN or DIRTY?             -b <branch> <path>         the new worktree
        |                     [base]                         |
        v                            |                       v
  +-------------+                    v                 +------------------+
  | CLEAN       |              +-------------+         | 🌲 <branch>      |
  | -> fast path|              | new checkout|         | name, title,     |
  | no stash    |              | sibling dir |         | widget, policy   |
  +-------------+              +-------------+         | tool calls       |
  | DIRTY       |                    |                 | re-rooted there  |
  | -> selective|  stash push -u ----+----> stash      +------------------+
  | stash carry |  (only task files)      apply --index
  +-------------+  rest stays in origin    drop on success
```

- **The agent names the branch** — no fixed format, no questions asked. Model-chosen collisions auto-bump (`-2`, `-3`). Pass `--branch` to name it yourself: with a clean workspace (or `--no-carry`) that creates immediately with no model roundtrip; a colliding `--branch` stays a hard error so your typos stay visible.
- **Dirty workspaces are triaged by the agent** — it carries only files related to the task (selective stash via `carryPaths`: `carrying 2 of 5 files · 3 left in origin`, each carried file shown with its `N`/`U`/`D`/`R` status and `+N`/`-N` counts) and leaves unrelated changes untouched in the origin, saying in one line what it left behind and why. No confirmation, ever. The stash is dropped only after a clean apply; on conflict the stash is kept and its ref is reported so nothing is lost. Staged deletions carry correctly — the selection is expressed as exclusions, because a positive pathspec naming a deleted file makes `git stash push` fail.
- **Clean workspace** — fast path with no stash dance. This is the ideal isolation moment: for experimental, risky, or parallel work, prefer `/worktree` over editing in place.
- New worktrees default to `<repo>.worktrees/<branch>`, deduplicated with `-2`, `-3`:

```text
  ~/repo                         ~/repo.worktrees/
  (origin: main)                 (children)
  +--------+                     +---------------------------+
  | .git/  |                     | wt-http-retry/            |
  +--------+                     | wt-http-retry-2/          |
                                 | wt-login-fix/             |
                                 +---------------------------+
```

```text
/worktree add retry tests for the http client
/worktree --branch login-retry --base main
/worktree --no-carry spike a risky refactor
```

After creation the session is **bound** to the worktree: the session name, terminal title and widget show `🌲 <branch>`, and the agent's tool calls run inside it (see below). The agent continues the task there and asks whether to land when done. With conversation history but no task text, the agent infers the task from the conversation and dirty files; when nothing is inferable it still creates the worktree and says it's ready — `/worktree` never comes back with a question about what to work on. Only with no conversation at all does it create silently and wait for you instead of guessing. One session owns at most one active worktree per repo — creating again points back at the owned link until it is landed or abandoned.

## Session binding — the virtual cwd

Pi keeps the session cwd at the origin after `/worktree`. Rather than asking the model to remember `cd <worktree> &&` on every command, the extension re-roots built-in tool calls while the session is bound:

```text
  session cwd (unchanged)         what the tools actually touch
  -----------------------         ------------------------------

  ~/repo (origin, main)           ~/repo.worktrees/wt-http-retry (bound root)
        |                                        ^
        |  bash  ── prepend cd <root> ───────────|
        |  read/edit/write/grep/find/ls ─────────|
        |    relative path → resolve under <root>|
        |    empty path    → default to <root>   |
        |    absolute origin write → BLOCKED ────|
        |      "Edit <twin> instead"             |
        +-- absolute origin read ── ALLOWED ─────+
            (comparisons are legit)
```

- `bash` commands start inside the worktree (unless they already `cd` there).
- Relative paths for `read`, `edit`, `write`, `grep`, `find`, `ls` resolve against the worktree; omitted paths default to it.
- `edit`/`write` aimed at an absolute path inside the **origin checkout** are blocked with a pointer to the worktree twin. Reads of the origin stay allowed for comparisons.
- The per-turn policy states one thing: `Working root: <worktree>`.

Standing inside the worktree yourself (a fresh session after `cd`) counts as bound too; nothing is rewritten because the cwd already is the root.

## /land — merge back

```text
/land [target] [--strategy rebase|merge|squash]
```

Land straight back into the origin — zero popups. Direction is DWIM: standing in a child lands it into its origin; standing at the origin lands the bound/only child into it.

### Land pipeline

```text
  1. resolve            2. checkpoint          3. merge           4. cleanup
  -------------         -----------------      ------------       --------------

  source = child        source dirty?          rebase /           worktree remove
  target = origin       -> commit (task        merge /            branch -d
  (or DWIM flip)           subject)            squash             (never main)
                        target dirty?               |
                        -> commit                   v
                           wip(<branch>):      +---------+
                           checkpoint ...      | success |--> LAND card
                                               +---------+
                                                    |
                                               +---------+
                                               |conflict |--> LAND CONFLICT
                                               +---------+    card, full stop
```

- **Strategy is asked once, remembered everywhere** (`~/.pi/agent/pid-worktree/config.json`). First `/land` asks rebase / squash / merge a single time; from then on that mode is the default and every land line shows it. An explicit `--strategy` wins for that run and becomes the new default.
- Pending changes on both sides are checkpoint-committed first (the worktree's uses the task as its subject, the origin's is marked `wip(<branch>): checkpoint before landing …`). The origin's checkpoint is shown as a trailing `N files checkpointed on <branch>` row — auto-created commits stay visible; the worktree's own checkpoint is folded into the landed commit list it produced, so the card never repeats the same subject twice. Land cards keep the commit summary and subjects separate from the file summary and paths.
- Empty worktrees land as cleanup: no commits and no changes means the worktree directory is removed, the branch deleted and the session unbound in the same `/land` — no second `abandon` step.

```text
/land
/land wt-http-retry --strategy squash
```

### Strategies compared

Given origin `main` at `C` and worktree branch with `W1, W2`:

```text
  BEFORE
  main:     A --- B --- C
  worktree:       C --- W1 --- W2
```

```text
  rebase (default): linear, no merge commit.
  Falls back to merge if the rebase hits conflicts.

  main:     A --- B --- C --- W1' --- W2'
```

```text
  merge: keeps history with a merge commit.

  main:     A --- B --- C ----------- M
                            \       /
                             W1 --- W2
```

```text
  squash: folds everything into one commit titled by the task.

  main:     A --- B --- C --- [W1+W2]
```

### Conflicts — the model resolves them

```text
  merge hits conflict
        |
        v
  ⚠️ LAND CONFLICT 【W -> main】
     └─ 2 files
        ├─ file_a
        └─ file_b
        |
        +-- model reads each file, keeps the intended result from both
        +-- sides, `git add`, finishes the land, explains the resolution
        +-- only asks you when both sides look deliberately contradictory
        |
        +-- model reads each file, keeps the intended result from both
        +-- sides, `git add`, finishes the land, explains the resolution
        +-- only asks you when both sides look deliberately contradictory
```

No popup. The model handles it and tells you what it kept; you only get asked when the two sides genuinely contradict each other.

Running `/land` at the origin lands the child this session owns and leaves other sessions' work alone (listed, untouched); with no own link it says so instead of popping a picker. Naming a branch/path explicitly takes it over deliberately, and the result notes the previous owner. `worktree_land` (the tool) never prompts and follows the remembered preference.

## Linkage — how sessions find each other

One file per link, in the shared git dir, so it survives `cd` and fresh sessions on either side:

```text
  .git/pid-worktree/
  |-- <link-id-1>.json     <-- session A owns wt-http-retry
  |-- <link-id-2>.json     <-- session B owns wt-login-fix
  +-- ...

  each link:
  {
    originPath, originBranch, originHead,
    worktreePath, branch, base,
    task, sessionId, status
  }
```

```text
  session A (~/repo)              git common dir              session B (worktree)
  ------------------              --------------              --------------------

  origin @ main                   pid-worktree/               cd ~/repo.worktrees/...
  creates wt-http-retry ──save──> <id-A>.json <──load── fresh session finds
                                  <id-B>.json ──save──> creates wt-login-fix
  every load reconciles against `git worktree list`:
  link points at a path git no longer lists → marked `removed`
```

- Parallel sessions only write their own file, so no session can clobber another's link. Two older layouts are read and merged on first load: a single `pi-worktree.json`, and the per-link directory under the extension's former name, `pi-worktree/`. Writes always use the current directory.
- Ownership scopes implicit work: a bare land/abandon resolves this session's own link (or the worktree you're standing in) and never auto-grabs another session's link. Naming a link explicitly takes it over deliberately — the result notes the previous owner (`foreign`), and the model says who owned it and what it did. Links created before ownership existed are unowned and landable by anyone.

```text
  who can land what?
  ------------------

  own link .............. YES
  unowned legacy link ... YES (single, auto)
  other session's link .. only when named explicitly (deliberate takeover, noted as foreign)
  standing inside it .... YES (possession counts)
```

The **session title bar** carries the worktree on its second line, beside the folder — and only when this session has one open:

```text
  open worktree ... 📁 repo   (🌲 wt-gate → main)  +58  −11   4 files   ↑3   1 dirty
  no worktree ..... 📁 repo   main
```

Two shapes, and the rule between them is the point: a worktree belongs to the session that opened it. Nothing else appears here — not another session's worktrees, not a roll-up of the repos under the folder. A folder of eight projects with nothing open says nothing at all.

When one *is* open it is drawn as objects rather than as a sentence: the branch and where it lands are one tinted chip, the line counts keep their own colours, and the secondary counts stay quiet — so the row is read at a glance instead of parsed. The numbers are the worktree's *whole* state against its origin, committed and uncommitted together (`git diff --shortstat <originBranch>`, two-dot on purpose), which is the count a person watching expects to move. A quiet worktree shows no numbers rather than `0 files`.

The second shape is not decoration either: registering a header mount makes PID stand its own branch chip down, so an extension that renders a header owes that chip back. It is drawn as a plain faint branch name — the same thing PID would have shown, with nothing added.

## The approval gate

Isolating work, landing it and throwing it away change where the work lives. When the agent decides
that on its own the call is stopped in the `tool_call` hook and put to the user first, as a card
carrying the numbers that matter:

```text
🌲 New worktree?
   └─ 🌲 WORKTREE 【main -> wt-gate】
         └─ carrying 2 of 5 files · 3 left in origin
            ├─ N  src/gate.ts    +4  -0
            └─ N  src/policy.ts  +1  -0

🌲 Land this worktree?
   └─ 🌲 LAND 【wt-gate -> main】 · will rebase
         ├─ 2 commits
         │  ├─ feat(gate): ask before isolating
         │  └─ test(gate): cover the decline path
         └─ 4 files
            ├─ U  src/gate.ts          +12   -3
            └─ N  test/gate.test.ts    +40   -0
```

Every number is read *before* anything happens, from the same helpers the tool would use — so the
question says `will rebase`, never `rebased`.

**Where the card lands depends on the host.** A terminal has nowhere to put it, so it is a dialog,
painted from these fields. A graphical host draws it in the transcript, on the row where the call
itself is, with two buttons — no modal takes the window to ask one question. That row also declares
`asks`, so a run that ends with a question outstanding does not fold it away with the rest of the
turn's steps: a button nobody can see is not an answer. Both surfaces are built from the same
structure: `src/ask-view.ts` decides what the card says, `src/ui.tsx` composes PID's primitives over
it, and the terminal renders the same fields through `diagramTree`/`fileColumns`.

The buttons run one command, `/worktree-answer yes|no` — which is also how a terminal user answers
by hand:

```text
  who is asked?
  -------------

  the agent's own initiative ......... ASKED   (create / land / abandon, the real thing)
  /worktree already typed ............ no      (the command armed create)
  /land already typed ................. no      (the command armed land, incl. finish:true)
  worktree_land abort:true ............ no      (the undo, not the landing)
  worktree_abandon confirm:false ...... no      (the dry run deletes nothing)
  worktree_status ..................... no      (triage plumbing, never gated)
  a worktree with nothing in it ....... no      (landing it is cleanup, not a decision)
  --print / --mode json ............... no      (no dialogs to raise)

  and the two that look like questions but are not:
  this session already holds one ...... no      (a second create only errors)
  a target that is not this session's . ASKED   (a takeover: no numbers, but the fact that matters)

  and when the question cannot be put to anyone:
  no card can be written .............. no      (no repo, no link: the tool's own error answers)
  a question is already open .......... HELD    (one at a time; the model is told to wait)
  nothing said to the user yet ........ HELD    (the card goes under the paragraph; asked once)
```

**The card describes the worktree that will actually change.** A `target` naming something this
session does not hold is a takeover, and it gets its own card — the host cannot read that worktree's
numbers, but it can state the one fact that matters, that this is not the user's own tree. Naming
the session's *own* link by branch or by path stays an ordinary card: `namesSameWorktree` compares
canonically so `/repo.worktrees/x` and `x` are not two different worktrees.

**A question is a card, and a card is the question.** The rule that falls out of that: when the
answer cannot be *shown* — no repository, no link to describe, nothing in the worktree to lose —
there is nothing to ask, so the call runs and answers for itself. A blocked call with no card would
end the run on a question nobody can see or click.

**One question at a time.** Two open cards would leave the first unattachable: the buttons answer a
question, and a person looking at two of them cannot tell which one they are answering. A second
gated call is held with `Waiting on the user: a question about … is already in the transcript`, and
frees itself the moment the first is answered.

**What the card counts is what the landing carries.** Before merging, a landing commits both sides:
the worktree's pending work goes in as one checkpoint commit (the task as its subject) and the
origin's pending work as `wip(<branch>)`. So the card counts the commits ahead *plus* that
checkpoint, lists the tracked files changed against the base (committed and uncommitted together,
two-dot), the untracked files a two-dot diff cannot see, and says a line about the origin's own
pending files — work in *someone's* working tree that this approval is about to commit.

**A yes is a hand-back, not a bypass.** It arms the gate and tells the model to re-issue the call it
already made, parameters and all — so the tool runs once, where it has always run, with all its cards
and cleanup intact. One answer per run in both directions: a yes is remembered, so a conflict's
`finish:true` does not re-ask; a no is remembered too, and a retry is blocked without a second card.
A question still on screen outlives the run that raised it, and only an answer clears it.

**A question does not survive the process.** It lives in the extension's memory, so a restart (or
PID reopening the session) drops it: the row falls back to its one-line record and the model's next
attempt asks again. That is deliberate — a question whose process is gone has no gate behind it
either, and re-asking is honest where a stale card would not be.

**The paragraph comes first — and the gate enforces it.** A card states numbers; it cannot say what
was decided, what was verified or what is still unsure, and a question with nothing above it is a
decision the user cannot make. So a gated call that carries no words for the user is stopped before
a card exists: nothing is drawn, nothing is held, and the model keeps its turn with
`Approval held: nothing said to the user about … yet.` It writes the paragraph, calls again, and the
card appears *under* it. Once per kind per run — a model that ignores the nudge gets its card anyway,
because a loop is worse than a quiet card. The instructions say the same thing in four more places
(the tool guidelines, the bound-session policy, the `/worktree` hand-off, the approval hand-back),
so this is the floor, not the only ask.

A decline reaches the model as `The user declined to open a worktree. Do not retry;` — so the work
continues where it already is, and the model says so in one line.

Because the host asks, the policy tells the model to *call* the tool rather than raise the question
in prose: the model speaks about work, the host asks about permission.

## Safety

- Never force-pushes; never pushes at all.
- Landing never uses `-D` (only `branch -d`, and keeps the branch when worktree removal fails). `worktree_abandon` does force-delete — after a dry run and explicit confirmation for non-empty worktrees (empty ones drop immediately), and never `main`/`master`.
- Stash apply tries `--index` first, falls back to plain apply, and drops the stash only on success.
- A failed rebase is aborted before falling back to merge; the worktree is never left mid-rebase.
- Cleanup never touches `main`/`master`: no auto-delete, no `worktree remove` against a main working tree.
- Both sides auto-commit before landing (task-named checkpoints); same-path lands and detached `HEAD` on either side are blocked with hints. Squash with nothing to land is reported as such, not as a conflict.

## Development

Run the test suite:

```bash
npm test
```

Typecheck:

```bash
npm run typecheck
```

Run Pi directly from the repository (print mode skips dialogs and uses the default strategy):

```bash
PI_OFFLINE=1 pi --no-session --no-extensions \
  --extension ./src/index.ts \
  --tools bash,read,write,edit,find,grep,ls \
  --mode json \
  -p '/worktree add retry tests --yes'
```

See the source and tests for implementation details and behavior coverage.

## License

MIT
