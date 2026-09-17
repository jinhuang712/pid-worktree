/**
 * The approval gate, end to end, against a host that is not a terminal.
 *
 * Headless on purpose: the point of the window path is that it never raises a dialog, so the fake
 * host's `confirm` throws. A test that passed by popping a modal would be testing the wrong build.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import register from "../src/index.ts";

type Fn = (...args: any[]) => any;

function sh(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve) => execFile("git", args, { cwd }, () => resolve()));
}

async function initRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "wt-approval-"));
  await sh(dir, ["init", "-b", "main"]);
  await sh(dir, ["config", "user.email", "test@example.com"]);
  await sh(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "a.txt"), "one\n");
  await sh(dir, ["add", "-A"]);
  await sh(dir, ["commit", "-m", "init"]);
  return dir;
}

/** Two dirty files, so `carryPaths` has something to leave behind. */
async function makeDirty(dir: string): Promise<void> {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "gate.ts"), "one\n");
  writeFileSync(join(dir, "notes.md"), "scratch\n");
}

/** A host that draws, and records what it was asked to draw. */
function makeHost() {
  const hooks: Record<string, Fn[]> = {};
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const messages: { content: string; opts: any; display?: boolean }[] = [];
  const userMessages: string[] = [];
  let dialogs = 0;
  const notices: string[] = [];
  /** The session's entries: what the extension reads to know whether the model has spoken. */
  let entries: any[] = [];
  /** The published widget, one slot — `setWidget` replaces, and clears when handed nothing. */
  let widget: string[] | undefined;

  const pi: any = {
    on(name: string, fn: Fn) {
      (hooks[name] ??= []).push(fn);
    },
    registerTool(t: any) {
      tools.set(t.name, t);
    },
    registerCommand(name: string, spec: any) {
      commands.set(name, spec);
    },
    registerMessageRenderer() {},
    appendEntry() {},
    sendMessage(message: any, opts: any) {
      messages.push({ content: message.content, opts, display: message.display });
    },
    /** The user's own words, delivered as the user's message rather than quoted into a note. */
    sendUserMessage(content: any) {
      userMessages.push(content);
    },
    setSessionName() {},
    getSessionName() {
      return null;
    },
    exec(cmd: string, args: string[], opts: any) {
      return new Promise((resolve) => {
        execFile(cmd, args, { cwd: opts?.cwd, timeout: opts?.timeout }, (err: any, stdout, stderr) => {
          resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code: err ? (err.code ?? 1) : 0 });
        });
      });
    },
  };

  /** The window: `mode: "rpc"`, a UI, and no way to raise a dialog. */
  const ctx = (cwd: string): any => ({
    cwd,
    hasUI: true,
    mode: "rpc",
    signal: undefined,
    ui: {
      confirm: async () => {
        dialogs += 1;
        throw new Error("a window must not raise a dialog");
      },
      notify(text: string) {
        notices.push(text);
      },
      setWidget(_key: string, lines?: string[]) {
        widget = lines;
      },
      setStatus() {},
      setTitle() {},
      select: async () => undefined,
      theme: { fg: (_c: string, s: string) => s, bold: (s: string) => s },
    },
    sessionManager: { getSessionId: () => "sess-1", getEntries: () => entries, getSessionFile: () => undefined },
  });

  /** The published payload, the way PID reads a widget key: replaced, never appended. */
  const lastAsk = () => (widget ? JSON.parse(widget.join("\n"))?.ask : undefined);
  const binding = () => (widget ? JSON.parse(widget.join("\n"))?.binding : undefined);

  return {
    pi,
    hooks,
    tools,
    commands,
    messages,
    userMessages,
    ctx,
    lastAsk,
    binding,
    dialogs: () => dialogs,
    notices,
    /** The newest message in the session: the assistant message the gate's call rides in. */
    setLastMessage(content: any[]) {
      entries = [{ type: "message", id: "m1", message: { role: "assistant", content } }];
    },
  };
}

const toolCall = (host: ReturnType<typeof makeHost>) => host.hooks.tool_call[0];

test("a window is asked in the transcript, never in a dialog", async () => {
  const dir = await initRepo();
  await makeDirty(dir);
  const host = makeHost();
  register(host.pi);
  const ctx = host.ctx(dir);
  const call = toolCall(host);

  const verdict = await call(
    {
      toolName: "worktree_create",
      toolCallId: "t1",
      input: { task: "gate the tools", branch: "wt-gate", carryPaths: ["src/gate.ts"] },
    },
    ctx,
  );

  // The call stops, the run ends, and nothing was asked in a dialog.
  assert.equal(verdict.block, true);
  assert.equal(verdict.terminate, true);
  assert.match(verdict.reason, /Approval asked: open a worktree/);
  assert.equal(host.dialogs(), 0);

  // The card the row will draw: numbers read before anything happened.
  const ask = host.lastAsk();
  assert.equal(ask.id, "t1");
  assert.equal(ask.kind, "create");
  assert.equal(ask.hero, "main -> wt-gate");
  assert.equal(ask.summary, "carrying 1 of 2 files · 1 left in origin");
  assert.deepEqual(
    ask.files.map((f: any) => f.path),
    ["src/gate.ts"],
  );
  assert.equal(typeof ask.files[0].added, "number");
});

test("the card's yes hands the model back exactly the call it made", async () => {
  const dir = await initRepo();
  await makeDirty(dir);
  const host = makeHost();
  register(host.pi);
  const ctx = host.ctx(dir);
  const call = toolCall(host);

  const input = { task: "gate the tools", branch: "wt-gate", carryPaths: ["src/gate.ts"] };
  await call({ toolName: "worktree_create", toolCallId: "t1", input }, ctx);
  await host.commands.get("worktree-answer").handler("yes", ctx);

  const sent = host.messages.at(-1) ?? { content: "", opts: {} };
  assert.match(sent.content, /The user approved: open a worktree/);
  assert.match(sent.content, /worktree_create/);
  assert.match(sent.content, /"branch":"wt-gate"/);
  // The recap comes before the call: the approval is the user's moment to read it.
  assert.match(sent.content, /what changed, what you verified, what the conclusion is/);
  assert.equal(sent.opts.triggerTurn, true);
  // The card stays where it was clicked, marked with the answer and stripped of its buttons —
  // the person who answered watches the run it handed back play out under it.
  assert.equal(host.lastAsk()?.answer, "yes");
  assert.equal(host.lastAsk()?.id, "t1");

  // The model re-issues it — recorded approval, so the call runs, once.
  const again = await call({ toolName: "worktree_create", toolCallId: "t2", input }, ctx);
  assert.equal(again, undefined);
  const result = await host.tools.get("worktree_create").execute("t2", input, undefined, undefined, ctx);
  assert.equal(result.details.ok, true);
  assert.ok(existsSync(join(`${dir}.worktrees`, "wt-gate", "src", "gate.ts")));
  // The file that stayed behind really stayed behind.
  assert.ok(existsSync(join(dir, "notes.md")));

  // The run that acted on the answer is over: the card goes, and the receipt it produced is the
  // row that tells the story from here.
  await host.hooks.agent_end[0]({}, ctx, undefined);
  assert.equal(host.lastAsk(), undefined);
});

test("a no is remembered: the retry is blocked without a second card", async () => {
  const dir = await initRepo();
  await makeDirty(dir);
  const host = makeHost();
  register(host.pi);
  const ctx = host.ctx(dir);
  const call = toolCall(host);

  await call({ toolName: "worktree_create", toolCallId: "t1", input: { branch: "wt-gate" } }, ctx);
  await host.commands.get("worktree-answer").handler("no", ctx);
  assert.match(host.messages.at(-1)?.content ?? "", /The user declined to open a worktree/);
  // A decline is an answer like any other: the card is marked, not erased.
  assert.equal(host.lastAsk()?.answer, "no");

  const retry = await call({ toolName: "worktree_create", toolCallId: "t2", input: { branch: "wt-gate" } }, ctx);
  assert.equal(retry.block, true);
  assert.match(retry.reason, /declined to open a worktree/);
  assert.equal(retry.terminate, undefined);
  // Asking twice about the same decision would be the second card this rule exists to prevent.
  assert.equal(host.lastAsk()?.id, "t1");
});

test("an answer that arrives twice is refused, not replayed", async () => {
  const dir = await initRepo();
  await makeDirty(dir);
  const host = makeHost();
  register(host.pi);
  const ctx = host.ctx(dir);
  const call = toolCall(host);

  await call({ toolName: "worktree_create", toolCallId: "t1", input: { branch: "wt-gate" } }, ctx);
  await host.commands.get("worktree-answer").handler("yes", ctx);
  const first = host.messages.length;
  // A second click on a card that no longer has buttons: the approval must not be re-sent, which
  // would be a second hand-back to the model and a second worktree.
  await host.commands.get("worktree-answer").handler("no", ctx);
  assert.equal(host.messages.length, first);
  assert.equal(host.lastAsk()?.answer, "yes");
});

test("a question nobody answered stays open across the run boundary", async () => {
  const dir = await initRepo();
  await makeDirty(dir);
  const host = makeHost();
  register(host.pi);
  const ctx = host.ctx(dir);
  const call = toolCall(host);

  await call({ toolName: "worktree_create", toolCallId: "t1", input: { branch: "wt-gate" } }, ctx);
  // The run ends while the card is still on screen.
  await host.hooks.agent_end[0]({}, ctx, undefined);

  const retry = await call({ toolName: "worktree_create", toolCallId: "t2", input: { branch: "wt-gate" } }, ctx);
  assert.equal(retry.block, true);
  assert.equal(host.dialogs(), 0);
});

test("the user's own /worktree is the answer already", async () => {
  const dir = await initRepo();
  await makeDirty(dir);
  const host = makeHost();
  register(host.pi);
  const ctx = host.ctx(dir);

  await host.commands.get("worktree").handler("isolate the gate work", ctx);

  // The command hands the create to the model, and the model's call is not asked about again.
  const verdict = await toolCall(host)(
    { toolName: "worktree_create", toolCallId: "t1", input: { branch: "wt-gate" } },
    ctx,
  );
  assert.equal(verdict, undefined);
  assert.equal(host.dialogs(), 0);
});

/**
 * A prompt typed after `/worktree` is a prompt.
 *
 * It used to be quoted into the extension's hand-off note instead — which lost the user's line
 * breaks, turned their screenshot into a bare path, and left the transcript with no message of
 * theirs to read, only an extension talking about them in the third person.
 */
const task = "main 画面里的黑色阴影太丑了，删掉\n\n<attachments>\nimage /tmp/shot.png\n</attachments>";

test("the task after /worktree reaches the model as the user's own words", async () => {
  const dir = await initRepo();
  const host = makeHost();
  register(host.pi);
  const ctx = host.ctx(dir);

  await host.commands.get("worktree").handler(task, ctx);

  // Verbatim: line breaks and the attachment block survive, because the file the user typed is
  // what they will read back in the transcript.
  assert.deepEqual(host.userMessages, [task]);
  // The how-to is the extension's business and stays out of the transcript: the model reads it,
  // the person does not.
  const note = host.messages.at(-1);
  assert.equal(note?.display, false);
  assert.match(note?.content ?? "", /Isolate that work into a new linked worktree/);
  assert.doesNotMatch(note?.content ?? "", /黑色阴影/);
});

test("a named branch with no triage to do reports the receipt, then the prompt", async () => {
  const dir = await initRepo();
  const host = makeHost();
  register(host.pi);
  const ctx = host.ctx(dir);

  await host.commands.get("worktree").handler(`--branch wt-gate ${task}`, ctx);

  assert.deepEqual(host.userMessages, [task]);
  const note = host.messages.at(-1);
  assert.match(note?.content ?? "", /Worktree ready: `wt-gate`/);
  // The receipt does not trigger the turn — the prompt does, and a second trigger would be a
  // second run over the same words.
  assert.equal(note?.opts?.triggerTurn, false);
  assert.doesNotMatch(note?.content ?? "", /黑色阴影/);
});

test("a bare /worktree with no task still hands the conversation to the model", async () => {
  const dir = await initRepo();
  const host = makeHost();
  register(host.pi);
  const ctx = host.ctx(dir);

  await host.commands.get("worktree").handler("", ctx);

  // Nothing for the user to say, so the note is the prompt: infer the task and continue.
  assert.deepEqual(host.userMessages, []);
  assert.match(host.messages.at(-1)?.content ?? "", /no task text/);
  assert.equal(host.messages.at(-1)?.opts?.triggerTurn, true);
});

/**
 * What the card is about.
 *
 * A landing carries the worktree's whole working tree — the land checkpoints it before it merges —
 * so a card that counted only `base..HEAD` reported `nothing new · nothing to clean` over a
 * worktree full of uncommitted work, which is the ordinary case: the agent finishes, the paragraph
 * says what changed, and the card asks the user to approve none of it.
 */
test("a land card counts the work still in the working tree", async () => {
  const dir = await initRepo();
  const host = makeHost();
  register(host.pi);
  const ctx = host.ctx(dir);

  await host.commands.get("worktree").handler("--branch wt-gate do the thing", ctx);
  const root = join(`${dir}.worktrees`, "wt-gate");
  // One edit to a tracked file, one file nobody has committed yet: both land.
  writeFileSync(join(root, "a.txt"), "one\ntwo\n");
  writeFileSync(join(root, "new.ts"), "export const x = 1;\n");

  const verdict = await toolCall(host)({ toolName: "worktree_land", toolCallId: "t9", input: {} }, ctx);
  assert.equal(verdict.block, true);

  const ask = host.lastAsk();
  assert.equal(ask.kind, "land");
  assert.equal(ask.summary, undefined); // no "nothing new" line: something is there
  assert.equal(ask.commitCount, 1); // the checkpoint the land writes for it
  assert.deepEqual(ask.files.map((f: any) => f.path).sort(), ["a.txt", "new.ts"]);
  assert.match(ask.commits.join(" | "), /uncommitted/);
});

/**
 * Nothing to decide is not a question.
 *
 * An empty worktree is cleanup: asking the user to approve a landing that would carry nothing put a
 * `nothing new · nothing to clean` card between them and the work. The call runs, and the tool's
 * own answer (cleaned up / kept) is what the transcript shows.
 */
test("an empty worktree lands and is discarded without a question", async () => {
  const dir = await initRepo();
  const host = makeHost();
  register(host.pi);
  const ctx = host.ctx(dir);

  await host.commands.get("worktree").handler("--branch wt-gate do the thing", ctx);

  // Landing it is cleanup: there is nothing to carry, so there is nothing to approve.
  const land = await toolCall(host)({ toolName: "worktree_land", toolCallId: "t9", input: {} }, ctx);
  assert.equal(land, undefined);
  // The dry run deletes nothing by construction, and the real one deletes nothing that exists.
  for (const [id, input] of [["t10", {}], ["t11", { confirm: true }]] as const) {
    const abandon = await toolCall(host)({ toolName: "worktree_abandon", toolCallId: id, input }, ctx);
    assert.equal(abandon, undefined, `${id} should not be a question`);
  }
  assert.equal(host.lastAsk(), undefined);
});

/**
 * One question at a time.
 *
 * The buttons answer a question; a person looking at two cards cannot tell which one they are
 * answering, so a second gated call is held with a reason that says what is in the way — and it is
 * not a refusal, because nothing has been declined.
 */
test("a second question waits for the first", async () => {
  const dir = await initRepo();
  const host = makeHost();
  register(host.pi);
  const ctx = host.ctx(dir);

  await host.commands.get("worktree").handler("--branch wt-gate do the thing", ctx);
  writeFileSync(join(`${dir}.worktrees`, "wt-gate", "new.ts"), "export const x = 1;\n");

  const land = await toolCall(host)({ toolName: "worktree_land", toolCallId: "t9", input: {} }, ctx);
  assert.equal(land.block, true);
  const held = await toolCall(host)(
    { toolName: "worktree_abandon", toolCallId: "t10", input: { confirm: true } },
    ctx,
  );
  assert.equal(held.block, true);
  assert.match(held.reason, /Waiting on the user: a question about land this worktree/);
  // The held call did not steal the card: answering the first one still answers the first one.
  await host.commands.get("worktree-answer").handler("no", ctx);
  assert.equal(host.lastAsk()?.id, "t9");
  assert.equal(host.lastAsk()?.answer, "no");
});

/**
 * Every card a window can be asked to approve, and what it must say.
 *
 * One table, because these are the cases that kept going wrong: the numbers have to be about the
 * worktree that will actually change, including the parts git keeps out of a plain `base..HEAD`.
 */
const landAsk = async (setup: (dir: string) => void, input: Record<string, unknown> = {}) => {
  const dir = await initRepo();
  const host = makeHost();
  register(host.pi);
  const ctx = host.ctx(dir);
  await host.commands.get("worktree").handler("--branch wt-gate do the thing", ctx);
  setup(dir);
  const verdict = await toolCall(host)({ toolName: "worktree_land", toolCallId: "t9", input }, ctx);
  return { dir, host, ctx, verdict, ask: host.lastAsk() };
};

test("an empty worktree lands without a question", async () => {
  const { verdict, ask } = await landAsk(() => {});
  assert.equal(verdict, undefined, "cleanup is not a decision");
  assert.equal(ask, undefined);
});

test("a land card reads the commits the worktree already has", async () => {
  const dir = await initRepo();
  const host = makeHost();
  register(host.pi);
  const ctx = host.ctx(dir);
  await host.commands.get("worktree").handler("--branch wt-gate do the thing", ctx);

  const root = join(`${dir}.worktrees`, "wt-gate");
  writeFileSync(join(root, "a.txt"), "one\ntwo\n");
  await sh(root, ["add", "-A"]);
  await sh(root, ["commit", "-m", "feat: two lines"]);

  const verdict = await toolCall(host)({ toolName: "worktree_land", toolCallId: "t9", input: {} }, ctx);
  assert.equal(verdict.block, true);
  const ask = host.lastAsk();
  assert.equal(ask.commitCount, 1);
  assert.deepEqual(ask.commits, ["feat: two lines"]);
  assert.deepEqual(ask.files.map((f: any) => [f.path, f.added, f.deleted]), [["a.txt", 1, 0]]);
});

test("a land card for a worktree with nothing of its own says what the origin has", async () => {
  const dir = await initRepo();
  const host = makeHost();
  register(host.pi);
  const ctx = host.ctx(dir);
  await host.commands.get("worktree").handler("--branch wt-gate do the thing", ctx);
  writeFileSync(join(dir, "notes.md"), "scratch\n");

  const verdict = await toolCall(host)({ toolName: "worktree_land", toolCallId: "t9", input: {} }, ctx);
  assert.equal(verdict.block, true);
  const ask = host.lastAsk();
  // No count — `0 commits` would be the same nothing-news the old card lied with.
  assert.equal(ask.commitCount, undefined);
  assert.match(ask.summary, /1 file pending in main/);
});

test("an abandon card counts what would be thrown away, and says nothing when it is empty", async () => {
  const dir = await initRepo();
  const host = makeHost();
  register(host.pi);
  const ctx = host.ctx(dir);
  await host.commands.get("worktree").handler("--branch wt-gate do the thing", ctx);

  // Empty: nothing to lose, nothing to ask.
  const empty = await toolCall(host)(
    { toolName: "worktree_abandon", toolCallId: "t1", input: { confirm: true } },
    ctx,
  );
  assert.equal(empty, undefined);

  const root = join(`${dir}.worktrees`, "wt-gate");
  writeFileSync(join(root, "new.ts"), "export const x = 1;\n");
  const withWork = await toolCall(host)(
    { toolName: "worktree_abandon", toolCallId: "t2", input: { confirm: true } },
    ctx,
  );
  assert.equal(withWork.block, true);
  assert.equal(host.lastAsk()?.summary, "1 dirty file will be discarded");
});

test("a land that names this session's own worktree is not a takeover", async () => {
  const dir = await initRepo();
  const host = makeHost();
  register(host.pi);
  const ctx = host.ctx(dir);
  await host.commands.get("worktree").handler("--branch wt-gate do the thing", ctx);
  const root = join(`${dir}.worktrees`, "wt-gate");
  writeFileSync(join(root, "new.ts"), "export const x = 1;\n");

  for (const target of ["wt-gate", root]) {
    await host.hooks.agent_end[0]({}, ctx, undefined);
    const verdict = await toolCall(host)(
      { toolName: "worktree_land", toolCallId: `t-${target}`, input: { target } },
      ctx,
    );
    assert.equal(verdict.block, true);
    const ask = host.lastAsk();
    assert.equal(ask.hero, "wt-gate -> main", `target ${target} is this session's own worktree`);
    assert.equal(ask.commitCount, 1);
    await host.commands.get("worktree-answer").handler("no", ctx);
  }
});

/**
 * The card goes under the model's words.
 *
 * A question with nothing above it is a decision the user cannot make — they are being asked to
 * approve something nobody described. The call is stopped before a card exists (nothing drawn,
 * nothing held, the turn goes on), and the model's re-issued call gets its card.
 */
test("the card waits for the model to say what it is about", async () => {
  const dir = await initRepo();
  const host = makeHost();
  register(host.pi);
  const ctx = host.ctx(dir);
  await host.commands.get("worktree").handler("--branch wt-gate do the thing", ctx);
  writeFileSync(join(`${dir}.worktrees`, "wt-gate", "new.ts"), "export const x = 1;\n");

  // Straight from work to a decision: the message holding the call says nothing.
  host.setLastMessage([{ type: "toolCall", id: "t1", name: "worktree_land", arguments: {} }]);
  const naked = await toolCall(host)({ toolName: "worktree_land", toolCallId: "t1", input: {} }, ctx);
  assert.equal(naked.block, true);
  assert.equal(naked.terminate, undefined, "the turn goes on: nothing is being asked yet");
  assert.equal(host.lastAsk(), undefined, "nothing was put in front of the user");
  assert.match(naked.reason, /Approval held/);

  // It writes the paragraph and asks again — now the question has words above it.
  host.setLastMessage([
    { type: "text", text: "改了 2 处：贴图缩放和文档。验过：headless 截图逐像素比对。" },
    { type: "toolCall", id: "t2", name: "worktree_land", arguments: {} },
  ]);
  const withWords = await toolCall(host)({ toolName: "worktree_land", toolCallId: "t2", input: {} }, ctx);
  assert.equal(withWords.block, true);
  assert.equal(withWords.terminate, true);
  assert.equal(host.lastAsk()?.id, "t2");
});

test("a terminal still gets a dialog, and no card", async () => {
  const dir = await initRepo();
  await makeDirty(dir);
  const host = makeHost();
  register(host.pi);
  const ctx = host.ctx(dir);
  ctx.mode = "tui";
  ctx.ui.confirm = async (title: string, message: string) => {
    assert.match(title, /New worktree\?/);
    assert.match(message, /🌲 WORKTREE 【main -> wt-gate】/);
    assert.match(message, /carrying 1 of 2 files · 1 left in origin/);
    return true;
  };

  const verdict = await toolCall(host)(
    { toolName: "worktree_create", toolCallId: "t1", input: { branch: "wt-gate", carryPaths: ["src/gate.ts"] } },
    ctx,
  );
  assert.equal(verdict, undefined);
  assert.equal(host.lastAsk(), undefined);
});

test("print and json runs are never asked at all", async () => {
  const dir = await initRepo();
  await makeDirty(dir);
  const host = makeHost();
  register(host.pi);
  const ctx = host.ctx(dir);
  ctx.hasUI = false;

  const verdict = await toolCall(host)(
    { toolName: "worktree_create", toolCallId: "t1", input: { branch: "wt-gate" } },
    ctx,
  );
  assert.equal(verdict, undefined);
  assert.equal(host.dialogs(), 0);
});

test("a host with no terminal theme still gets the binding", async () => {
  // PID's worker hands out `theme: undefined` (its theme list is empty when the extension context
  // is built) while declaring the member served. Reaching for `.fg` on it threw inside the chrome
  // refresh, whose own catch swallowed it — so nothing was ever published and a window showed no
  // worktree at all. The chrome paints only for a terminal; outside one it must not touch the theme.
  const dir = await initRepo();
  const host = makeHost();
  register(host.pi);
  const created = await host.tools
    .get("worktree_create")
    .execute("t1", { branch: "wt-theme" }, undefined, undefined, host.ctx(dir));
  assert.equal(created.details.ok, true);

  const wtCtx = host.ctx(join(`${dir}.worktrees`, "wt-theme"));
  wtCtx.ui.theme = undefined;
  await host.hooks.session_start[0]({}, wtCtx, undefined);

  assert.equal(host.binding()?.branch, "wt-theme");
  assert.equal(host.binding()?.dest, "main");
  assert.equal(host.binding()?.inside, true);

  // The other half of the same resolution: the session sits at the origin and owns the worktree,
  // which is how it looks after /worktree — the cwd never moves, only the link's owner matches.
  const originCtx = host.ctx(dir);
  originCtx.ui.theme = undefined;
  await host.hooks.session_start[0]({}, originCtx, undefined);
  assert.equal(host.binding()?.branch, "wt-theme");
  assert.equal(host.binding()?.inside, false);
});
