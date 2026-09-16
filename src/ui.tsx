/**
 * The desktop half of this extension.
 *
 * The terminal half paints a line into the footer and a widget above the editor. In a window the
 * same numbers belong on the session title bar, next to the folder — "where this work lands" is the
 * more useful answer than the plain git branch when the two differ.
 *
 * Declared as `"pid": { "ui": "./src/ui.tsx" }`. The terminal half is untouched by any of this.
 */

import { Inline, Say } from "@pid/ui";
import type { WorktreeWidget } from "./host-widget.ts";

interface Api {
  readonly id: string;
  header: (spec: { render: (ctx: { state: unknown; run: (c: string) => Promise<unknown> }) => unknown }) => void;
}

export default function register(pid: Api) {
  pid.header({
    render: ({ state }) => {
      const w = state as WorktreeWidget | undefined;
      if (w?.binding) {
        const b = w.binding;
        const bits: string[] = [];
        if (b.ahead) bits.push(`↑${b.ahead}`);
        if (b.behind) bits.push(`↓${b.behind}`);
        if (b.dirty) bits.push(`${b.dirty} dirty`);
        return (
          <Inline title={b.task ? `${b.branch} → ${b.dest} · ${b.task}` : `${b.branch} → ${b.dest}`}>
            <Say tone="warn" mono truncate>
              🌲 {b.branch} → {b.dest}
            </Say>
            {bits.length > 0 && <Say tone="faint">· {bits.join(" · ")}</Say>}
          </Inline>
        );
      }
      const kids = w?.children ?? [];
      if (kids.length === 0) return null;
      return (
        <Inline title={kids.map((k) => k.branch).join(", ")}>
          <Say tone="faint" mono truncate>
            🌲 {kids.length} {kids.length === 1 ? "worktree" : "worktrees"}
          </Say>
        </Inline>
      );
    },
  });
}
