/**
 * The desktop half of this extension.
 *
 * Two jobs.
 *
 * The session's second line says which worktree the work lands in: the numbers belong next to the
 * folder, because "where does this go" is the more useful answer than the plain git branch.
 *
 * And a worktree-changing call the agent decided on its own is drawn where the call itself is — a
 * card in the transcript with its own buttons. The terminal asks the same question in a dialog,
 * because a terminal has nowhere else to put it; a window does, and a modal that takes the whole
 * window to ask one question is the worse answer there. That row is also the one thing a finished
 * turn keeps in sight: it says `asks` while the question stands, so the fold that puts the run's
 * steps behind a line does not put the buttons behind it as well.
 *
 * What the card says lives in `ask-view.ts`; this file is the composition. Declared as
 * `"pid": { "ui": "./src/ui.tsx" }`. The terminal half is untouched by any of it.
 */

import { Action, Badge, Inline, Line, Num, Panel, Say, Spread, Stack } from "@pid/ui";
import {
  CONFIRM,
  KIND_OF,
  worktreeLine,
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
} from "./ask-view.ts";
import type { AskCard, AskFile, PendingAsk, WorktreeWidget } from "./host-widget.ts";

interface PluginCtx {
  state: unknown;
  /** Runs a command in the session this row belongs to, as though the user typed it. */
  run: (command: string) => Promise<unknown>;
}

interface ToolRunLike {
  status?: string;
  isError?: boolean;
  result?: { content?: { type?: string; text?: string }[]; details?: unknown };
}

interface ToolDraw {
  call: { id: string; name: string; arguments?: unknown };
  run?: ToolRunLike;
  Frame: (props: { verb?: string; detail?: string; meta?: unknown; body?: string; children?: unknown }) => unknown;
}

interface Api {
  readonly id: string;
  /** The session title bar's second line, next to the folder. */
  header: (spec: { render: (ctx: PluginCtx) => unknown }) => void;
  tool: (spec: {
    names: string[];
    render: (draw: ToolDraw, ctx: PluginCtx) => unknown;
    /** PID keeps the row in sight while this says the call is a question the turn is waiting on. */
    asks?: (call: { id: string }, ctx: PluginCtx) => boolean;
  }) => void;
}

// ---------------------------------------------------------------- the card

function FileLine({ file }: { file: AskFile }) {
  const n = fileNumbers(file);
  return (
    <Line pad={false} gap="tight">
      <Badge tone={toneOf(file.status)}>{letter(file.status)}</Badge>
      <Say mono truncate className="min-w-0" title={file.path}>
        {file.path}
      </Say>
      <Spread />
      <Num className="text-ok">{n.added}</Num>
      <Num className="text-danger">{n.deleted}</Num>
    </Line>
  );
}

/** The card body, shared by the question and by the receipt: the same rows either way. */
function CardBody({ card }: { card: AskCard }) {
  const files = card.files ?? [];
  const commits = card.commits ?? [];
  const head =
    card.commitCount !== undefined
      ? `${card.commitCount} ${card.commitCount === 1 ? "commit" : "commits"}${
          files.length > 0 ? ` · ${files.length} ${files.length === 1 ? "file" : "files"}` : ""
        }`
      : card.summary;
  return (
    <Stack pad={false} gap="tight" className="min-w-0">
      <Inline gap="normal">
        <Say tone="warn" mono>
          {LABEL[card.kind]}
        </Say>
        <Say mono>{`【${card.hero}】`}</Say>
        {card.note ? <Say tone="faint">{`· ${card.note}`}</Say> : null}
      </Inline>

      {head ? <Say tone="faint">{head}</Say> : null}

      {commits.map((s) => (
        <Say key={s} tone="soft" className="pl-3 truncate" title={s}>
          {s}
        </Say>
      ))}

      {files.map((f) => (
        <FileLine key={f.path} file={f} />
      ))}
    </Stack>
  );
}

/** The question: the card, and the two ways out of it — or, once answered, the answer where they were. */
function AskBlock({ ask, run }: { ask: PendingAsk; run: (command: string) => Promise<unknown> }) {
  return (
    <Panel className="my-1 px-4 py-3 max-w-[640px]">
      <Stack pad={false} gap="normal">
        <Say tone="soft">{TITLE[ask.kind]}</Say>
        <CardBody card={ask} />
        <Line pad={false} gap="normal">
          {ask.answer ? (
            // The buttons are gone because the question is: what stays is the answer, so the person
            // who clicked can see what they did while the run it handed back plays out below.
            <Badge tone={ask.answer === "yes" ? "ok" : "muted"}>
              {ask.answer === "yes" ? "Approved" : "Declined"}
            </Badge>
          ) : (
            <>
              <Action tone="accent" onClick={() => void run(answerCommand(true))}>
                {CONFIRM[ask.kind]}
              </Action>
              <Action onClick={() => void run(answerCommand(false))}>Not now</Action>
            </>
          )}
        </Line>
      </Stack>
    </Panel>
  );
}

/** A settled call: the standard row, with the card behind the chevron. */
function SettledRow({ call, run, Frame }: { call: ToolDraw["call"]; run: ToolRunLike | undefined; Frame: ToolDraw["Frame"] }) {
  const kind = KIND_OF[call.name] ?? "create";
  const card = receiptOf(call.name, run);
  if (!card) return <Say tone="faint">{`🌲 ${stoppedText(run)}`}</Say>;
  return (
    <Frame verb={rowVerb(kind, run?.status)} detail={card.hero.split(" -> ").pop() ?? ""} body="none">
      <CardBody card={card} />
    </Frame>
  );
}

// ---------------------------------------------------------------- registration

export default function register(pid: Api) {
  // The worktree line sits in the session title bar, on the line that belongs to this session.
  // It is drawn as objects rather than as a sentence: the branch and where it lands are one tinted
  // chip, the line counts keep their own colours, and the secondary counts stay quiet — so the row
  // can be read at a glance instead of parsed.
  //
  // Registering a header is what makes PID stand its own branch chip down, which is right here: this
  // line already names the branch and the branch it lands in.
  pid.header({
    render: (ctx) => {
      const view = worktreeLine(ctx.state as WorktreeWidget | undefined);
      if (!view) return null;
      const counts = view.added ?? view.deleted;
      // A worktree open is news and gets a chip. Nothing open is PID's own metadata — a plain line,
      // the way PID would have drawn it, so claiming this mount never shouts about nothing.
      if (view.tone === "faint") {
        return (
          <Inline gap="tight" title={view.detail}>
            <Say tone="faint" mono>
              {view.text}
            </Say>
            {view.bits.length > 0 ? <Say tone="faint">{view.bits.join(" · ")}</Say> : null}
          </Inline>
        );
      }
      return (
        <Inline gap="normal" title={view.detail}>
          <Badge tone="warn">
            <Say mono>{view.text}</Say>
          </Badge>
          {counts ? (
            <Inline gap="tight">
              <Num className="text-ok">{view.added}</Num>
              <Num className="text-danger">{view.deleted}</Num>
            </Inline>
          ) : null}
          {view.files ? <Say tone="faint">{view.files}</Say> : null}
          {view.bits.length > 0 ? <Say tone="faint">{view.bits.join(" · ")}</Say> : null}
        </Inline>
      );
    },
  });

  pid.tool({
    names: ["worktree_create", "worktree_land", "worktree_abandon"],
    // A question the turn is waiting on is not a step of the work — and the buttons that answer it
    // live on this row — so PID folds a finished turn's steps without hiding the question. Read
    // off the published state, not the run: a blocked call's result is the text the model was
    // handed back, not something a host should parse.
    asks: (call, ctx) => askForCall(ctx.state, call.id) !== undefined,
    render: (draw, ctx) => {
      // The question belongs to the call that raised it; other rows of the same tool stay receipts.
      const ask = askForCall(ctx.state, draw.call.id);
      if (ask) return <AskBlock ask={ask} run={ctx.run} />;
      return <SettledRow call={draw.call} run={draw.run} Frame={draw.Frame} />;
    },
  });
}
