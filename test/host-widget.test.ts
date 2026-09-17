import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BINDING_WIDGET_KEY, publishBinding, wantsWidget } from "../src/host-widget.ts";

function fakeCtx(mode: string, hasUI: boolean) {
  const calls: { key: string; lines: string[] | undefined }[] = [];
  const ctx = {
    mode,
    hasUI,
    ui: {
      setWidget(key: string, lines: string[] | undefined) {
        calls.push({ key, lines });
      },
    },
  } as unknown as ExtensionContext;
  return { ctx, calls };
}

test("wantsWidget is true only for a drawing host that is not a terminal", () => {
  assert.equal(wantsWidget(fakeCtx("rpc", true).ctx), true);
  // A terminal already has the painted status line; the widget would duplicate it.
  assert.equal(wantsWidget(fakeCtx("tui", true).ctx), false);
  assert.equal(wantsWidget(fakeCtx("print", false).ctx), false);
  assert.equal(wantsWidget(fakeCtx("json", false).ctx), false);
});

test("publishes the binding as numbers, with no escape codes", () => {
  const { ctx, calls } = fakeCtx("rpc", true);
  publishBinding(ctx, {
    binding: {
      branch: "wt-fix-login",
      dest: "main",
      ahead: 3,
      behind: 1,
      dirty: 2,
      task: "fix the login redirect",
      worktreePath: "/repo/.worktrees/fix-login",
      originPath: "/repo",
      inside: true,
      files: 4,
      added: 58,
      deleted: 11,
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].key, BINDING_WIDGET_KEY);
  const payload = JSON.parse(calls[0].lines?.[0] ?? "{}");
  assert.equal(payload.binding.branch, "wt-fix-login");
  assert.equal(payload.binding.ahead, 3);
  // The terminal line runs these through theme.fg(); the payload must not.
  assert.equal(calls[0].lines?.[0].includes(""), false);
});

test("publishes the plain branch when no worktree is open", () => {
  const { ctx, calls } = fakeCtx("rpc", true);
  publishBinding(ctx, { repo: { branch: "main" } });
  const payload = JSON.parse(calls[0].lines?.[0] ?? "{}");
  assert.deepEqual(payload.repo, { branch: "main" });
  // Nothing worktree-shaped rides along: no chip, no counts, nothing to explain.
  assert.equal(payload.binding, undefined);
  assert.equal(payload.ask, undefined);
});

test("clears with undefined", () => {
  const { ctx, calls } = fakeCtx("rpc", true);
  publishBinding(ctx, undefined);
  assert.deepEqual(calls, [{ key: BINDING_WIDGET_KEY, lines: undefined }]);
});

test("stays out of a terminal", () => {
  const { ctx, calls } = fakeCtx("tui", true);
  publishBinding(ctx, { repo: { branch: "main" } });
  assert.deepEqual(calls, []);
});

test("never throws, so chrome cannot break the session", () => {
  const ctx = {
    mode: "rpc",
    hasUI: true,
    ui: {
      setWidget() {
        throw new Error("host went away");
      },
    },
  } as unknown as ExtensionContext;
  assert.doesNotThrow(() => publishBinding(ctx, { repo: { branch: "main" } }));
});
