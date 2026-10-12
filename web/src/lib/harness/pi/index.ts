// The pi adapter. Herdr reports stock pi and OmO (the Senpi engine) alike as exactly `pi`, so this one
// adapter reads both, and every pi question extension through one reader (ask.ts, .adr/0098).
//
// Registering it moves every pi pane off the one-step send onto the guarded one (lib/reply-action.ts),
// which types only when `composerReady` says yes and submits only when the draft reads back. So the
// editor of every layout must be read (composer.ts), or a pi send is refused.
//
// Every reader below reads `piView(lines)`: the screen, or the screen cropped at OmO's side panel
// (panel.ts). Rows keep their indices, and nothing read from a cropped view is bound on the screen.
import { trimTrailingBlank, type Block, type StyledLine } from "../../blocks";
import type { HarnessAdapter } from "../types";
import { detectPiQuestion, piModalOnScreen } from "./ask";
import { composerDraft, composerPrompt, composerStatusLines, locateComposer } from "./composer";
import { piView } from "./panel";

export function piBuildBlocks(lines: StyledLine[]): Block[] {
  const view = piView(lines);
  // A question beside the side panel stays raw: its rows are not the screen's, so the bridge would
  // refuse every tap bound to them. The Escape card still offers the way out.
  const question = view.cropped ? null : detectPiQuestion(lines);
  if (question !== null) {
    const before = trimTrailingBlank(lines.slice(0, question.startLine));
    const blocks: Block[] = before.length > 0 ? [{ kind: "raw", lines: before }] : [];
    const region = lines.slice(question.startLine);
    blocks.push(
      question.kind === "prompt-select"
        ? { kind: "prompt-select", prompt: question.model, lines: region }
        : { kind: "wizard", wizard: question.model, lines: region },
    );
    return blocks;
  }
  // The editor comes off the mirror only when it is the editor: a modal can fill the same rules with
  // rows the stock layout would accept (pi's `/model` picker opens with its `>` search row,
  // pi--v110-core-selector.txt), and the mirror must keep it.
  const composer = ready(view.lines) ? locateComposer(view.lines) : null;
  return [{ kind: "raw", lines: composer === null ? lines : trimTrailingBlank(lines.slice(0, composer.top)) }];
}

/** The editor is on screen and no pi modal is: the only screen a reply may be typed into. A question's
 *  inline answer editor is not a place the phone types (.adr/0098), so it answers false. */
function ready(view: StyledLine[]): boolean {
  return locateComposer(view) !== null && !piModalOnScreen(view);
}

function composerReady(lines: StyledLine[]): boolean {
  return ready(piView(lines).lines);
}

/** The editor frame to bind a write to. None on a cropped view: the bridge matches whole screen rows,
 *  so the write goes out unbound, and the read-back still guards Enter. */
function boundPrompt(lines: StyledLine[]): string | null {
  const view = piView(lines);
  return !view.cropped && ready(view.lines) ? composerPrompt(view.lines) : null;
}

/** Herdr reports stock pi and OmO as exactly `pi`; no prefix or executable-name inference. */
export const piAdapter: HarnessAdapter = {
  agent: "pi",
  buildBlocks: piBuildBlocks,
  extractStatusLines: (lines) => composerStatusLines(piView(lines).lines),
  extractInputDraft: (lines) => {
    const view = piView(lines).lines;
    return ready(view) ? composerDraft(view) : null;
  },
  composerReady,
  composerPrompt: boundPrompt,
  // The way out every pi question screen prints: `Esc to cancel` (stock question, pi--v0871-*),
  // `Esc cancel` (stock questionnaire), `esc cancel` (OmO, pi--omo-v5130-*), `Esc to go back` and
  // `esc discard` in the inline answer editors, and `Escape/Ctrl+C to cancel` on pi's own pickers
  // (pi--v110-core-selector.txt). Offered by name: on an answer editor it steps back, it does not end
  // the question.
  cancelKey: "Escape",
  modalOnScreen: (lines) => piModalOnScreen(piView(lines).lines),
};
