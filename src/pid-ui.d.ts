/**
 * Types for the host primitives a desktop half composes.
 *
 * The real implementations live in the host (`src/renderer/ui/` in PID) and reach this module
 * through a shim at load time — nothing is installed from npm. This file exists so the extension's
 * own `tsc` can check the half it ships; it is a mirror, and the host is the source of truth.
 *
 * Kept loose on purpose: enough to catch a typo in a primitive's name or a missing prop, not enough
 * to pretend this repository owns the component library.
 */

declare namespace JSX {
  type Element = unknown;
  interface ElementChildrenAttribute {
    children: Record<string, never>;
  }
  /** `key` is the renderer's, not a component's, so it is accepted on every element. */
  interface IntrinsicAttributes {
    key?: string | number;
  }
  interface IntrinsicElements {
    [tag: string]: Record<string, unknown>;
  }
}

declare module "@pid/jsx-runtime" {
  export const jsx: (...args: unknown[]) => unknown;
  export const jsxs: (...args: unknown[]) => unknown;
  export const Fragment: unknown;
}

declare module "@pid/ui" {
  type Node = unknown;
  type Tone = "ok" | "warn" | "danger" | "muted" | "accent";
  interface Base {
    className?: string;
    title?: string;
    children?: Node;
  }

  export function Badge(p: Base & { tone?: Tone }): Node;
  export function Dot(p: Base & { tone?: Tone }): Node;
  export function Num(p: Base): Node;
  export function Eyebrow(p: Base): Node;
  export function Panel(p: Base): Node;
  export function Line(p: Base & { gap?: "tight" | "normal" | "wide"; pad?: boolean }): Node;
  export function Stack(p: Base & { gap?: "tight" | "normal" | "wide"; pad?: boolean }): Node;
  export function Spread(): Node;
  export function Action(
    p: Base & { tone?: "soft" | "danger" | "accent"; disabled?: boolean; onClick?: () => void },
  ): Node;
  export function Inline(p: Base & { gap?: "tight" | "normal" }): Node;
  export function Say(
    p: Base & {
      tone?: "normal" | "soft" | "faint" | "warn" | "danger" | "ok" | "accent";
      mono?: boolean;
      truncate?: boolean;
    },
  ): Node;
  export function Floating(p: Base): Node;
  export function Divider(p: { inset?: boolean; className?: string }): Node;
  export function Scroll(p: Base): Node;
  export function Row(
    p: Base & { active?: boolean; hover?: boolean; disabled?: boolean; onClick?: () => void },
  ): Node;
  export function IconButton(
    p: Base & {
      size?: "sm" | "md" | "lg";
      ground?: boolean;
      disabled?: boolean;
      onClick?: () => void;
    },
  ): Node;
  export function Toggle(p: {
    value: boolean;
    onChange: (v: boolean) => void;
    disabled?: boolean;
    title?: string;
  }): Node;
  export function Segmented<T extends string>(p: {
    options: readonly T[];
    labels?: Partial<Record<T, string>>;
    value: T;
    onChange: (v: T) => void;
    label?: string;
  }): Node;
  export function Trigger(
    p: Base & { placement?: "up" | "down"; onClick: () => void },
  ): Node;
  export function Keys(p: { keys: string[]; label?: string }): Node;
}
