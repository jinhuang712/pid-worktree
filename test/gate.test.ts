import assert from "node:assert/strict";
import { test } from "node:test";
import { Gate, awaitingReason, deniedReason, gateKind, type GateFacts } from "../src/gate.ts";

const ask = (
  toolName: string,
  params: Record<string, unknown> = {},
  hasUI = true,
  saidToUser = true,
): GateFacts => ({ toolName, hasUI, params, saidToUser });

test("only the three worktree-changing tools are gated", () => {
  assert.equal(gateKind("worktree_create"), "create");
  assert.equal(gateKind("worktree_land"), "land");
  assert.equal(gateKind("worktree_abandon"), "abandon");
  // Status is pure triage plumbing: reading it must never raise a dialog.
  assert.equal(gateKind("worktree_status"), undefined);
  assert.equal(gateKind("bash"), undefined);
});

test("the agent's own initiative is asked about", () => {
  const g = new Gate();
  assert.equal(g.decide(ask("worktree_create")), "ask");
  assert.equal(g.decide(ask("worktree_land")), "ask");
  // The real thing asks…
  assert.equal(g.decide(ask("worktree_abandon", { confirm: true })), "ask");
  // …but `confirm:false` is the dry run: it reports what would be lost and deletes nothing.
  assert.equal(g.decide(ask("worktree_abandon")), "allow");
  assert.equal(g.decide(ask("worktree_status")), "allow");
});

/**
 * The card goes under the model's words.
 *
 * A question with no explanation above it is a decision the user cannot make. The call is sent back
 * once — nothing held, nothing drawn — and the second attempt gets its card whether or not the
 * model listened, because a nudge that can loop is worse than a quiet card.
 */
test("a call with nothing said to the user is sent back for the paragraph", () => {
  const g = new Gate();
  assert.equal(g.decide(ask("worktree_land", {}, true, false)), "explain");
  // The model keeps its turn: asking again, with words this time, is the card.
  assert.equal(g.decide(ask("worktree_land", {}, true, true)), "ask");

  const stubborn = new Gate();
  assert.equal(stubborn.decide(ask("worktree_land", {}, true, false)), "explain");
  assert.equal(stubborn.decide(ask("worktree_land", {}, true, false)), "ask");

  // A new run is a new chance to say it.
  const nextRun = new Gate();
  assert.equal(nextRun.decide(ask("worktree_land", {}, true, false)), "explain");
  nextRun.reset();
  assert.equal(nextRun.decide(ask("worktree_land", {}, true, false)), "explain");
});

test("one question at a time", () => {
  const g = new Gate();
  assert.equal(g.decide(ask("worktree_land")), "ask");
  g.asked("land");
  // A second card would leave the first one unattachable: the buttons answer one question, and a
  // person looking at two of them cannot tell which one they are answering.
  assert.equal(g.decide(ask("worktree_create")), "deny");
  assert.equal(g.openKind(), "land");
  g.answered("land", true);
  assert.equal(g.openKind(), undefined);
  // Answering it frees the next one, which then asks as usual.
  assert.equal(g.decide(ask("worktree_create")), "ask");
});

test("a command the user typed is already the answer", () => {
  const g = new Gate();
  g.arm("create");
  assert.equal(g.decide(ask("worktree_create")), "allow");
  // Consumed: a second create in the same run asks again.
  assert.equal(g.decide(ask("worktree_create")), "ask");
});

test("no dialog channel means no question", () => {
  const g = new Gate();
  assert.equal(g.decide(ask("worktree_create", {}, false)), "allow");
});

test("aborting a conflicted merge is the undo, not the landing", () => {
  const g = new Gate();
  assert.equal(g.decide(ask("worktree_land", { abort: true })), "allow");
  // The real landing still asks.
  assert.equal(g.decide(ask("worktree_land", { finish: true })), "ask");
});

test("one answer per run, in both directions", () => {
  const yes = new Gate();
  yes.answered("land", true);
  assert.equal(yes.decide(ask("worktree_land")), "allow");
  // …and only for what was answered.
  assert.equal(yes.decide(ask("worktree_create")), "ask");

  const no = new Gate();
  no.answered("create", false);
  assert.equal(no.decide(ask("worktree_create")), "deny");
});

test("the next run asks again", () => {
  const g = new Gate();
  g.answered("create", false);
  assert.equal(g.decide(ask("worktree_create")), "deny");
  g.reset();
  assert.equal(g.decide(ask("worktree_create")), "ask");
});

test("an unanswered command stays armed across runs", () => {
  const g = new Gate();
  g.arm("create");
  g.reset();
  assert.equal(g.decide(ask("worktree_create")), "allow");
});

test("a question already on screen blocks a retry without asking again", () => {
  const g = new Gate();
  assert.equal(g.decide(ask("worktree_create")), "ask");
  g.asked("create");
  assert.equal(g.decide(ask("worktree_create")), "deny");
  // The answer clears it, and a yes lets the call through the second time.
  g.answered("create", true);
  assert.equal(g.decide(ask("worktree_create")), "allow");
});

test("an open question outlives the run that raised it", () => {
  const g = new Gate();
  g.asked("land");
  g.reset(); // the run ended with the card still on screen
  assert.equal(g.decide(ask("worktree_land")), "deny");
  g.answered("land", false);
  assert.equal(g.decide(ask("worktree_land")), "deny");
  // A fresh run after a real answer asks again.
  g.reset();
  assert.equal(g.decide(ask("worktree_land")), "ask");
});

test("the hand-off and the decline each tell the model what to do next", () => {
  const hand = awaitingReason("create");
  // The row shows this line once the question is answered and the run is over, so it is written as
  // a record of what was asked — true before and after the answer.
  assert.equal(hand.split("\n")[0], "Approval asked: open a worktree.");
  assert.match(hand, /do not retry/);
  // The recap is the one thing the card's numbers cannot say.
  assert.match(hand, /what changed and what the conclusion is/);
  assert.match(awaitingReason("land"), /Approval asked: land this worktree/);
  assert.match(deniedReason("abandon"), /declined to abandon this worktree/);
});

test("the decline tells the model to stop trying", () => {
  const reason = deniedReason("create");
  assert.match(reason, /declined to open a worktree/);
  assert.match(reason, /Do not retry/);
});
