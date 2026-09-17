/**
 * What the transcript card says, without a window.
 *
 * The desktop half is a composition over these; every value that could be wrong — a status letter,
 * a tone, a summary, the command a button runs — is decided here and read back here.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONFIRM,
  worktreeLine,
  KIND_OF,
  LABEL,
  TITLE,
  answerCommand,
  askForCall,
  fileNumbers,
  letter,
  receiptOf,
  rowVerb,
  stoppedText,
  toneOf,
} from "../src/ask-view.ts";

test("git's letters become the table's, with a tone that means the same thing", () => {
  assert.equal(letter("A"), "N");
  assert.equal(letter("C"), "N");
  assert.equal(letter("M"), "U");
  assert.equal(letter("T"), "U");
  assert.equal(letter("D"), "D");
  assert.equal(letter("R"), "R");

  assert.equal(toneOf("A"), "ok");
  assert.equal(toneOf("D"), "danger");
  assert.equal(toneOf("M"), "warn");
  assert.equal(toneOf("R"), "warn");
});

test("numbers carry the sign, and a binary file says so", () => {
  assert.deepEqual(fileNumbers({ status: "M", path: "a.ts", added: 12, deleted: 3 }), {
    added: "+12",
    deleted: "−3",
  });
  assert.deepEqual(fileNumbers({ status: "A", path: "b.bin", added: null, deleted: null }), {
    added: "bin",
    deleted: "",
  });
});

test("the buttons run the one command the agent half answers on", () => {
  assert.equal(answerCommand(true), "/worktree-answer yes");
  assert.equal(answerCommand(false), "/worktree-answer no");
});

test("the question belongs to the call that raised it", () => {
  const state = { ask: { id: "t1", kind: "create", hero: "main -> wt-x" } };
  assert.equal(askForCall(state, "t1")?.kind, "create");
  // A different row of the same tool is not holding this question.
  assert.equal(askForCall(state, "t2"), undefined);
  assert.equal(askForCall(undefined, "t1"), undefined);
  assert.equal(askForCall({ binding: {} }, "t1"), undefined);
});

test("every kind names its own button, and they are not all 'Yes'", () => {
  const labels = Object.keys(KIND_OF) as (keyof typeof KIND_OF)[];
  const kinds = labels.map((tool) => KIND_OF[tool]);
  assert.deepEqual(kinds, ["create", "land", "abandon"]);
  const buttons = kinds.map((k) => CONFIRM[k]);
  assert.deepEqual(new Set(buttons).size, 3);
  for (const k of kinds) {
    assert.ok(TITLE[k].length > 0);
    assert.ok(LABEL[k].includes("🌲") || LABEL[k].includes("🗑️"));
  }
});

test("the row's verb knows which tense it is in", () => {
  assert.equal(rowVerb("create", "running"), "Isolating");
  assert.equal(rowVerb("create", "done"), "Isolated");
  assert.equal(rowVerb("land", "done"), "Landed");
  assert.equal(rowVerb("abandon", undefined), "Discarded");
});

test("the receipt repeats the tool's own numbers, not new ones", () => {
  const run = {
    status: "done",
    result: {
      details: {
        ok: true,
        from: "main",
        branch: "wt-gate",
        carried: ["src/gate.ts"],
        total: 2,
        changes: [{ status: "M", path: "src/gate.ts", added: 4, deleted: 1 }],
      },
    },
  };
  const card = receiptOf("worktree_create", run);
  assert.equal(card?.kind, "create");
  assert.equal(card?.hero, "main -> wt-gate");
  assert.equal(card?.summary, "carrying 1 of 2 files · 1 left in origin");
  assert.equal(card?.files?.[0].added, 4);
});

test("a clean create says so instead of 'carrying 0 files'", () => {
  const card = receiptOf("worktree_create", {
    status: "done",
    result: { details: { ok: true, from: "main", branch: "wt-x", carried: [], total: 0, changes: [] } },
  });
  assert.equal(card?.summary, "clean · nothing to carry");
});

test("a blocked or failed call has no receipt — it gets one dim line", () => {
  assert.equal(receiptOf("worktree_create", { status: "done", isError: true, result: { content: [] } }), undefined);
  assert.equal(receiptOf("worktree_create", { status: "done", result: { details: { ok: false, reason: "not-a-repo" } } }), undefined);
  assert.equal(receiptOf("worktree_status", { status: "done", result: { details: { ok: true, branch: "x" } } }), undefined);

  assert.equal(
    stoppedText({ result: { content: [{ type: "text", text: "\n  The user declined to open a worktree.\n" }] } }),
    "The user declined to open a worktree.",
  );
  assert.equal(stoppedText({ result: { content: [] } }), "No result.");
});

test("a land receipt reads as a merge, not as a carry", () => {
  const card = receiptOf("worktree_land", {
    status: "done",
    result: {
      details: {
        ok: true,
        from: "main",
        branch: "wt-gate",
        changes: [{ status: "M", path: "src/gate.ts", added: 4, deleted: 1 }],
      },
    },
  });
  assert.equal(card?.kind, "land");
  assert.equal(card?.summary, "1 file landed");
});

// ---------------------------------------------------------------- the worktree line

const bound = (over: Record<string, unknown> = {}) => ({
  binding: {
    branch: "wt-gate",
    dest: "main",
    ahead: 2,
    behind: 0,
    dirty: 1,
    files: 4,
    added: 58,
    deleted: 11,
    task: "gate the tools",
    worktreePath: "/x",
    originPath: "/y",
    inside: false,
    ...over,
  },
});

test("a session with an open worktree says where it lands, and how much work is in it", () => {
  const view = worktreeLine(bound());
  assert.equal(view?.text, "🌲 wt-gate → main");
  assert.equal(view?.files, "4 files");
  assert.equal(view?.added, "+58");
  assert.equal(view?.deleted, "−11");
  assert.deepEqual(view?.bits, ["↑2", "1 dirty"]);
  assert.equal(view?.tone, "warn");
  assert.match(view?.detail ?? "", /gate the tools/);
});

test("a quiet worktree shows no numbers rather than zeroes", () => {
  const view = worktreeLine(bound({ files: 0, added: 0, deleted: 0, ahead: 0, behind: 0, dirty: 0 }));
  assert.equal(view?.files, undefined);
  assert.equal(view?.added, undefined);
  assert.deepEqual(view?.bits, []);
  // The chip is still there: the worktree is open, which is the whole reason this line exists.
  assert.equal(view?.text, "🌲 wt-gate → main");
});

test("no worktree says the branch and nothing else", () => {
  const view = worktreeLine({ repo: { branch: "main" } });
  assert.equal(view?.text, "main");
  assert.deepEqual(view?.bits, []);
  assert.equal(view?.tone, "faint");
  assert.equal(view?.files, undefined);
  assert.equal(worktreeLine({ repo: { branch: null } })?.text, "detached");
});

test("another session's worktrees are not this session's business", () => {
  // The payload has no way to say it: a shape that only carries someone else's worktrees draws
  // nothing at all.
  assert.equal(worktreeLine(undefined), undefined);
  assert.equal(worktreeLine({}), undefined);
  assert.equal(worktreeLine({ repo: undefined }), undefined);
});

test("the worktree outranks the branch line", () => {
  const view = worktreeLine({ ...bound(), repo: { branch: "main" } });
  assert.equal(view?.text, "🌲 wt-gate → main");
  assert.equal(view?.tone, "warn");
});
